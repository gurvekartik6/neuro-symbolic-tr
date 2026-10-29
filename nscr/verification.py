"""Deterministic checks over user-supplied evidence.
Never creates synthetic execution data.
"""


def dependency_cycles(steps: list[dict]) -> list[list[str]]:
    graph = {
        step.get("id"): list(step.get("depends_on", []))
        for step in steps
    }

    color = {}
    stack = []
    cycles = []
    seen = set()

    def visit(node):
        color[node] = 1
        stack.append(node)

        for next_node in graph.get(node, []):
            if next_node not in graph:
                continue

            if color.get(next_node, 0) == 0:
                visit(next_node)
            elif color.get(next_node) == 1:
                cycle = stack[stack.index(next_node):] + [next_node]
                if tuple(cycle) not in seen:
                    seen.add(tuple(cycle))
                    cycles.append(cycle)

        stack.pop()
        color[node] = 2

    for node in graph:
        if color.get(node, 0) == 0:
            visit(node)

    return cycles


def evaluate_rule(rule: dict, events_by_id: dict[str, dict]) -> dict:
    event_id = rule.get("event_id")
    event = events_by_id.get(event_id) if event_id else None

    if event is None and not event_id and len(events_by_id) == 1:
        event = next(iter(events_by_id.values()))

    if event is None:
        return {
            "status": "not_evaluable",
            "reason": "Referenced event is missing or ambiguous.",
        }

    value = event.get(rule["field"])
    operator = rule["operator"]
    expected = rule.get("expected_value")

    try:
        if operator == "equals":
            passed = value == expected
        elif operator == "not_equals":
            passed = value != expected
        elif operator == "exists":
            passed = value is not None and value != ""
        elif operator == "truthy":
            passed = bool(value)
        elif operator == "contains":
            passed = expected in value if value is not None else False
        else:
            return {
                "status": "not_evaluable",
                "reason": "Unsupported operator.",
            }
    except (TypeError, ValueError):
        return {
            "status": "not_evaluable",
            "reason": "Values could not be compared.",
        }

    return {
        "status": "passed" if passed else "failed",
        "event_id": event.get("event_id"),
        "field": rule["field"],
        "observed": value,
        "expected": expected,
        "operator": operator,
    }


def verify_run(
    plan: dict,
    events: list[dict],
    causal_conclusion: str = "undetermined",
) -> dict:
    steps = plan.get("steps", [])
    step_ids = {step.get("id") for step in steps}

    ids: list[str | None] = [event.get("event_id") for event in events]
    duplicates = sorted({
        value for value in ids
        if value is not None and ids.count(value) > 1
    })

    unknown_steps = sorted({
        step_id
        for event in events
        if isinstance(step_id := event.get("step_id"), str)
        and step_id not in step_ids
    })

    cycles = dependency_cycles(steps)

    failed_events = sorted(
        event["event_id"]
        for event in events
        if event.get("status") == "failed"
    )

    failed_pre = sorted(
        event["event_id"]
        for event in events
        if event.get("preconditions_met") is False
    )

    failed_post = sorted(
        event["event_id"]
        for event in events
        if event.get("postconditions_met") is False
    )

    by_event = {
        event["event_id"]: event
        for event in events
        if event.get("event_id")
    }

    constraints = []

    for constraint in plan.get("constraints", []):
        if constraint.get("rule"):
            constraints.append({
                "constraint_id": constraint.get("id"),
                "statement": constraint.get("statement"),
                **evaluate_rule(constraint["rule"], by_event),
            })
        else:
            constraints.append({
                "constraint_id": constraint.get("id"),
                "statement": constraint.get("statement"),
                "status": "not_evaluable",
                "reason": "No explicit machine-checkable rule was supplied.",
            })

    if not events or any(
        event.get("status") == "unknown" for event in events
    ):
        completeness = "incomplete"
    elif any(
        event.get("input_observation") is None
        or event.get("output_observation") is None
        for event in events
    ):
        completeness = "partial"
    else:
        completeness = "recorded"

    notes = [
        "Checks apply only to entered evidence; they cannot establish "
        "that observations are truthful or complete."
    ]

    if cycles:
        notes.append(
            "The plan contains dependency cycles; causal ordering may be ambiguous."
        )

    if unknown_steps:
        notes.append(
            "Some events reference step IDs absent from the plan."
        )

    if duplicates:
        notes.append(
            "Duplicate event IDs make evidence references ambiguous."
        )

    if any(
        item["status"] == "not_evaluable"
        for item in constraints
    ):
        notes.append(
            "Some constraints could not be checked mechanically and require review."
        )

    if causal_conclusion == "undetermined":
        notes.append(
            "Temporal order and model confidence alone do not establish causation."
        )

    return {
        "trace_event_count": len(events),
        "unknown_step_ids": unknown_steps,
        "duplicate_event_ids": duplicates,
        "dependency_cycles": cycles,
        "failed_events": failed_events,
        "failed_preconditions": failed_pre,
        "failed_postconditions": failed_post,
        "constraint_results": constraints,
        "evidence_completeness": completeness,
        "causal_conclusion": causal_conclusion,
        "notes": notes,
    }


def intervention_assessment(
    payload: dict,
    known_step_ids: set[str],
) -> dict:
    if payload["candidate_step_id"] not in known_step_ids:
        return {
            "status": "undetermined",
            "reason": "Candidate step is not present in the plan.",
        }

    if not payload.get("intervention_was_executed"):
        return {
            "status": "undetermined",
            "reason": (
                "Intervention was not reported as executed; "
                "this is a proposed test, not causal evidence."
            ),
        }

    if not payload.get("conditions_held_constant"):
        return {
            "status": "undetermined",
            "reason": (
                "No controlled conditions were recorded, so outcomes "
                "cannot be causally attributed to this intervention."
            ),
        }

    if (
        payload["baseline_outcome"].strip()
        == payload["intervention_outcome"].strip()
    ):
        return {
            "status": "not_supported",
            "reason": (
                "Recorded outcomes did not differ under the stated intervention."
            ),
        }

    return {
        "status": "intervention_supported",
        "reason": (
            "Reported outcomes differ under the intervention with stated controls. "
            "This supports, but does not prove, causality; validate the evidence "
            "source and controls."
        ),
    }


def validate_step_graph(
    steps: list[dict],
    min_steps: int = 1,
    max_steps: int = 12,
) -> None:
    if not min_steps <= len(steps) <= max_steps:
        raise ValueError(f"expected {min_steps}-{max_steps} steps")

    ids = [step.get("id") for step in steps]

    if len(ids) != len(set(ids)) or any(not value for value in ids):
        raise ValueError("duplicate or missing step IDs")

    valid = set(ids)

    for step in steps:
        unknown = set(step.get("depends_on", [])) - valid

        if unknown:
            raise ValueError(
                f"step {step['id']} depends on unknown IDs: {sorted(unknown)}"
            )

        if step["id"] in step.get("depends_on", []):
            raise ValueError(
                f"step {step['id']} depends on itself"
            )

    cycles = dependency_cycles(steps)

    if cycles:
        raise ValueError(f"dependency cycles detected: {cycles}")