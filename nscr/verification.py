from __future__ import annotations

from collections import defaultdict


SUPPORTED_RULE_FIELDS = {
    "status",
    "preconditions_met",
    "postconditions_met",
    "input_observation",
    "output_observation",
}

SUPPORTED_OPERATORS = {
    "equals",
    "not_equals",
    "exists",
    "truthy",
    "contains",
}


def dependency_cycles(steps: list[dict]) -> list[list[str]]:
    """Return dependency cycles using depth-first search."""
    graph: dict[str, list[str]] = {}
    for step in steps:
        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id:
            continue

        dependencies = step.get("depends_on", [])
        graph[step_id] = (
            [dependency for dependency in dependencies if isinstance(dependency, str)]
            if isinstance(dependencies, list)
            else []
        )

    state: dict[str, int] = {}
    stack: list[str] = []
    cycles: list[list[str]] = []
    seen_cycles: set[tuple[str, ...]] = set()

    def visit(node: str):
        state[node] = 1
        stack.append(node)

        for dependency in graph.get(node, []):
            if not isinstance(dependency, str):
                continue

            if dependency not in graph:
                continue

            if state.get(dependency, 0) == 0:
                visit(dependency)

            elif state.get(dependency) == 1:
                start = stack.index(dependency)
                cycle = stack[start:] + [dependency]
                canonical = tuple(cycle)

                if canonical not in seen_cycles:
                    seen_cycles.add(canonical)
                    cycles.append(cycle)

        stack.pop()
        state[node] = 2

    for node in graph:
        if state.get(node, 0) == 0:
            visit(node)

    return cycles


def validate_step_graph(steps: list[dict]) -> None:
    """Raise ValueError if step IDs or dependencies are invalid."""
    ids = [step.get("id") for step in steps]

    if any(not step_id for step_id in ids):
        raise ValueError("Every step must have a non-empty ID.")

    if len(ids) != len(set(ids)):
        raise ValueError("Step IDs must be unique.")

    known = set(ids)

    for step in steps:
        step_id = step["id"]
        dependencies = step.get("depends_on", [])

        if len(dependencies) != len(set(dependencies)):
            raise ValueError(
                f"Step {step_id} contains duplicate dependencies."
            )

        for dependency in dependencies:
            if dependency not in known:
                raise ValueError(
                    f"Step {step_id} depends on unknown step {dependency}."
                )

            if dependency == step_id:
                raise ValueError(
                    f"Step {step_id} cannot depend on itself."
                )

    cycles = dependency_cycles(steps)

    if cycles:
        raise ValueError(f"Dependency cycle(s) found: {cycles}")


def validate_plan_structure(
    plan: dict,
    min_steps: int = 1,
    max_steps: int = 20,
) -> dict:
    """Validate plan structure and references without claiming semantics."""
    errors: list[str] = []
    warnings: list[str] = []

    steps = plan.get("steps", [])

    if not isinstance(steps, list):
        return {
            "valid": False,
            "errors": ["Plan steps must be a list."],
            "warnings": [],
        }

    if not min_steps <= len(steps) <= max_steps:
        errors.append(
            f"Plan must contain between {min_steps} and {max_steps} steps."
        )

    try:
        validate_step_graph(steps)
    except ValueError as exc:
        errors.append(str(exc))

    step_ids = {
        step.get("id")
        for step in steps
        if isinstance(step, dict) and step.get("id")
    }

    constraint_ids: list[str] = []

    for constraint in plan.get("constraints", []):
        if not isinstance(constraint, dict):
            errors.append("Every constraint must be an object.")
            continue

        constraint_id = constraint.get("id")

        if constraint_id:
            constraint_ids.append(constraint_id)

        for step_id in constraint.get("relevant_step_ids", []):
            if step_id not in step_ids:
                errors.append(
                    f"Constraint {constraint_id} references unknown "
                    f"step {step_id}."
                )

        rule = constraint.get("rule")

        if rule:
            if rule.get("field") not in SUPPORTED_RULE_FIELDS:
                errors.append(
                    f"Constraint {constraint_id} uses an unsupported field."
                )

            if rule.get("operator") not in SUPPORTED_OPERATORS:
                errors.append(
                    f"Constraint {constraint_id} uses an unsupported operator."
                )

    if len(constraint_ids) != len(set(constraint_ids)):
        errors.append("Constraint IDs must be unique.")

    if not plan.get("task_summary"):
        warnings.append("Plan has no task summary.")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "step_count": len(steps),
        "constraint_count": len(plan.get("constraints", [])),
    }


def _truthy(value) -> bool:
    if value is None:
        return False

    if isinstance(value, str):
        return bool(value.strip())

    return bool(value)


def evaluate_rule(rule: dict, event_by_id: dict) -> dict:
    """Evaluate a supported rule against a named trace event."""
    event_id = rule.get("event_id")

    if not event_id:
        return {
            "status": "not_evaluable",
            "reason": "Rule does not specify an event_id.",
        }

    event = event_by_id.get(event_id)

    if event is None:
        return {
            "status": "not_evaluable",
            "reason": f"Event {event_id} was not supplied.",
        }

    field = rule.get("field")
    operator = rule.get("operator")
    expected = rule.get("expected_value")
    actual = event.get(field)

    if field not in SUPPORTED_RULE_FIELDS:
        return {
            "status": "not_evaluable",
            "reason": f"Unsupported rule field: {field}.",
        }

    if operator not in SUPPORTED_OPERATORS:
        return {
            "status": "not_evaluable",
            "reason": f"Unsupported operator: {operator}.",
        }

    if operator == "exists":
        passed = actual is not None and actual != ""

    elif operator == "truthy":
        passed = _truthy(actual)

    elif operator == "equals":
        passed = actual == expected

    elif operator == "not_equals":
        passed = actual != expected

    elif operator == "contains":
        if not isinstance(actual, (str, list, tuple, set)):
            return {
                "status": "not_evaluable",
                "reason": (
                    "The contains operator requires text or a collection."
                ),
            }

        if not isinstance(expected, str):
            return {
                "status": "not_evaluable",
                "reason": (
                    "The expected value for contains must be a string."
                ),
            }

        passed = expected in actual

    else:
        return {
            "status": "not_evaluable",
            "reason": "Unsupported operator.",
        }

    return {
        "status": "passed" if passed else "failed",
        "event_id": event_id,
        "field": field,
        "operator": operator,
        "expected_value": expected,
        "actual_value": actual,
    }


def verify_run(
    plan: dict,
    events: list[dict],
    causal_conclusion: str = "undetermined",
) -> dict:
    """Check trace consistency and evidence completeness."""
    plan_validation = validate_plan_structure(plan)
    steps = plan.get("steps", [])
    known_steps = {
        step.get("id")
        for step in steps
        if step.get("id")
    }

    event_ids = [event.get("event_id") for event in events]
    duplicate_event_ids = sorted({
        event_id for event_id in event_ids
        if event_id and event_ids.count(event_id) > 1
    })

    unknown_step_ids = sorted({
        step_id
        for event in events
        if isinstance(step_id := event.get("step_id"), str)
        and step_id not in known_steps
    })

    unknown_status_events = [
        event.get("event_id")
        for event in events
        if event.get("status", "unknown") == "unknown"
    ]

    failed_events = [
        event.get("event_id")
        for event in events
        if event.get("status") == "failed"
    ]

    failed_preconditions = [
        event.get("event_id")
        for event in events
        if event.get("preconditions_met") is False
    ]

    failed_postconditions = [
        event.get("event_id")
        for event in events
        if event.get("postconditions_met") is False
    ]

    event_by_id = {
        event.get("event_id"): event
        for event in events
        if event.get("event_id")
    }

    constraint_results = []

    for constraint in plan.get("constraints", []):
        rule = constraint.get("rule")

        if not rule:
            result = {
                "status": "not_evaluable",
                "reason": (
                    "Constraint has no supported machine-checkable rule; "
                    "human review is required."
                ),
            }
        else:
            result = evaluate_rule(rule, event_by_id)

        constraint_results.append({
            "constraint_id": constraint.get("id"),
            "statement": constraint.get("statement"),
            **result,
        })

    observed_step_ids = {
        event.get("step_id")
        for event in events
        if event.get("step_id")
        and event.get("status") != "unknown"
        and event.get("source")
        != "generated_template_pending_observation"
    }

    missing_step_ids = sorted(known_steps - observed_step_ids)

    notes = []

    if duplicate_event_ids:
        notes.append("Duplicate event IDs were found.")

    if unknown_step_ids:
        notes.append("Trace references step IDs absent from the plan.")

    if unknown_status_events:
        notes.append("Some trace events have unknown outcomes.")

    if missing_step_ids:
        notes.append(
            "Some planned steps have no known-status observation."
        )

    if any(
        item["status"] == "not_evaluable"
        for item in constraint_results
    ):
        notes.append(
            "One or more constraints require manual evaluation."
        )

    if failed_events or failed_preconditions or failed_postconditions:
        notes.append(
            "At least one event or precondition/postcondition check failed."
        )

    # Do not infer causal proof from temporal order or failure alone.
    conclusion = causal_conclusion or "undetermined"

    if conclusion not in {
        "undetermined",
        "intervention_supported",
        "not_supported",
    }:
        conclusion = "undetermined"

    return {
        "plan_validation": plan_validation,
        "trace_event_count": len(events),
        "duplicate_event_ids": duplicate_event_ids,
        "unknown_step_ids": unknown_step_ids,
        "unknown_status_events": unknown_status_events,
        "failed_events": failed_events,
        "failed_preconditions": failed_preconditions,
        "failed_postconditions": failed_postconditions,
        "missing_step_ids": missing_step_ids,
        "constraint_results": constraint_results,
        "causal_conclusion": conclusion,
        "notes": notes,
    }


def intervention_assessment(
    payload: dict,
    known_step_ids: set[str],
) -> dict:
    """Assess reported intervention results conservatively."""
    candidate = payload.get("candidate_step_id")
    executed = payload.get("intervention_was_executed", False)
    controls = payload.get("conditions_held_constant") or []
    source = payload.get("evidence_source", "").strip()
    baseline = payload.get("baseline_outcome")
    intervention = payload.get("intervention_outcome")

    reasons = []

    if candidate not in known_step_ids:
        reasons.append("Candidate step is not in the plan.")

    if not executed:
        reasons.append("The intervention was not reported as executed.")

    if not controls:
        reasons.append("No controlled conditions were recorded.")

    if not source:
        reasons.append("No evidence source was supplied.")

    if baseline is None or intervention is None:
        reasons.append("Baseline or intervention outcome is missing.")

    if reasons:
        return {
            "status": "undetermined",
            "reasons": reasons,
            "human_review_required": True,
        }

    if baseline != intervention:
        status = "intervention_supported"
        explanation = (
            "The reported outcome changed under the intervention. "
            "This supports a causal hypothesis but does not prove causality."
        )
    else:
        status = "not_supported"
        explanation = (
            "The reported outcome did not change. "
            "This does not rule out causality under other conditions."
        )

    return {
        "status": status,
        "explanation": explanation,
        "candidate_step_id": candidate,
        "conditions_held_constant": controls,
        "evidence_source": source,
        "human_review_required": True,
    }


def assess_retest(plan: dict, events: list[dict]) -> dict:
    """Assess revised-plan retest evidence without claiming proof."""
    structure = validate_plan_structure(
        plan,
        min_steps=1,
        max_steps=20,
    )

    verification = verify_run(plan, events)
    steps = plan.get("steps", [])
    known_steps = {
        step.get("id")
        for step in steps
        if step.get("id")
    }

    observed_step_ids = {
        event.get("step_id")
        for event in events
        if event.get("step_id")
        and event.get("status") != "unknown"
        and event.get("source")
        != "generated_template_pending_observation"
    }

    unobserved_steps = sorted(known_steps - observed_step_ids)

    constraint_failures = [
        item for item in verification["constraint_results"]
        if item.get("status") == "failed"
    ]

    unevaluable_constraints = [
        item for item in verification["constraint_results"]
        if item.get("status") == "not_evaluable"
    ]

    failures = bool(
        verification["failed_events"]
        or verification["failed_preconditions"]
        or verification["failed_postconditions"]
        or constraint_failures
    )

    incomplete = bool(
        unobserved_steps
        or verification["unknown_status_events"]
        or verification["duplicate_event_ids"]
        or verification["unknown_step_ids"]
        or unevaluable_constraints
        or not structure["valid"]
    )

    if failures:
        status = "retest_failed"
    elif incomplete:
        status = "inconclusive"
    else:
        status = "recovery_supported_pending_human_review"

    return {
        "status": status,
        "plan_validation": structure,
        "verification": verification,
        "unobserved_step_ids": unobserved_steps,
        "constraint_failures": constraint_failures,
        "unevaluable_constraints": unevaluable_constraints,
        "human_review_required": True,
        "limitations": [
            "Evidence is user-supplied and has not been independently authenticated.",
            "A successful retest supports recovery but does not prove the repair caused it.",
            "Semantic constraints require appropriate human or domain-expert review.",
        ],
    }