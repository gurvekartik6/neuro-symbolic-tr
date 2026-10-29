
"""Evidence verification for NS-CR Research Lab.

This module validates plans, checks execution traces, evaluates constraints,
assesses reported interventions, and evaluates repair retests.

Important principles:
- A plan does not establish that execution occurred.
- Unknown observations remain unknown.
- A failure alone does not prove a cause.
- An intervention result is a causal hypothesis, not proof.
- Missing evidence must not be treated as a successful test.
"""

from __future__ import annotations


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
            [
                dependency
                for dependency in dependencies
                if isinstance(dependency, str)
            ]
            if isinstance(dependencies, list)
            else []
        )

    state: dict[str, int] = {}
    stack: list[str] = []
    cycles: list[list[str]] = []
    seen_cycles: set[tuple[str, ...]] = set()

    def visit(node: str) -> None:
        state[node] = 1
        stack.append(node)

        for dependency in graph.get(node, []):
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

        if not isinstance(dependencies, list):
            raise ValueError(
                f"Dependencies for step {step_id} must be a list."
            )

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

    if not isinstance(plan, dict):
        return {
            "valid": False,
            "errors": ["Plan must be an object."],
            "warnings": [],
        }

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

    if any(not isinstance(step, dict) for step in steps):
        errors.append("Every plan step must be an object.")
        steps_for_validation = [
            step for step in steps if isinstance(step, dict)
        ]
    else:
        steps_for_validation = steps

    try:
        validate_step_graph(steps_for_validation)
    except (ValueError, TypeError) as exc:
        errors.append(str(exc))

    step_ids = {
        step.get("id")
        for step in steps_for_validation
        if step.get("id")
    }

    constraints = plan.get("constraints", [])

    if not isinstance(constraints, list):
        errors.append("Plan constraints must be a list.")
        constraints = []

    constraint_ids: list[str] = []

    for constraint in constraints:
        if not isinstance(constraint, dict):
            errors.append("Every constraint must be an object.")
            continue

        constraint_id = constraint.get("id")

        if constraint_id:
            constraint_ids.append(constraint_id)

        relevant_ids = constraint.get("relevant_step_ids", [])

        if not isinstance(relevant_ids, list):
            errors.append(
                f"Constraint {constraint_id} has invalid relevant_step_ids."
            )
            relevant_ids = []

        for step_id in relevant_ids:
            if step_id not in step_ids:
                errors.append(
                    f"Constraint {constraint_id} references unknown "
                    f"step {step_id}."
                )

        rule = constraint.get("rule")

        if rule is not None:
            if not isinstance(rule, dict):
                errors.append(
                    f"Constraint {constraint_id} has an invalid rule."
                )
                continue

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
        "constraint_count": len(constraints),
    }


def _truthy(value) -> bool:
    """Return whether a recorded value is meaningfully present."""
    if value is None:
        return False

    if isinstance(value, str):
        return bool(value.strip())

    return bool(value)


def evaluate_rule(rule: dict, event_by_id: dict) -> dict:
    """Evaluate a supported rule against a named trace event."""
    if not isinstance(rule, dict):
        return {
            "status": "not_evaluable",
            "reason": "Rule is not an object.",
        }

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

    # Generated templates are placeholders, not actual observations.
    if event.get("source") == "generated_template_pending_observation":
        return {
            "status": "not_evaluable",
            "reason": "The referenced event is an unobserved template.",
        }

    if event.get("status", "unknown") == "unknown":
        return {
            "status": "not_evaluable",
            "reason": "The referenced event has an unknown outcome.",
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

    # Do not turn missing values into false observations.
    if actual is None and operator != "exists":
        return {
            "status": "not_evaluable",
            "reason": f"The field {field} was not observed.",
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


def _is_observed_event(event: dict) -> bool:
    """Determine whether an event contains usable, non-template evidence."""
    if not isinstance(event, dict):
        return False

    if event.get("source") == "generated_template_pending_observation":
        return False

    if event.get("status", "unknown") == "unknown":
        return False

    return True


def verify_run(
    plan: dict,
    events: list[dict],
    causal_conclusion: str = "undetermined",
) -> dict:
    """Check trace consistency and evidence completeness."""
    events = events if isinstance(events, list) else []

    plan_validation = validate_plan_structure(plan)

    steps = plan.get("steps", []) if isinstance(plan, dict) else []

    known_steps: set[str] = {
        step_id
        for step in steps
        if isinstance(step, dict)
        and isinstance(step_id := step.get("id"), str)
        and step_id
    }

    event_ids = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
    ]

    duplicate_event_ids = sorted({
        event_id
        for event_id in event_ids
        if event_id and event_ids.count(event_id) > 1
    })

    unknown_step_ids = sorted({
        step_id
        for event in events
        if isinstance(event, dict)
        and isinstance(step_id := event.get("step_id"), str)
        and step_id not in known_steps
    })

    unknown_status_events = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
        and event.get("status", "unknown") == "unknown"
    ]

    failed_events = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
        and event.get("status") == "failed"
    ]

    failed_preconditions = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
        and event.get("preconditions_met") is False
    ]

    failed_postconditions = [
        event.get("event_id")
        for event in events
        if isinstance(event, dict)
        and event.get("postconditions_met") is False
    ]

    event_by_id = {
        event.get("event_id"): event
        for event in events
        if isinstance(event, dict) and event.get("event_id")
    }

    constraint_results = []

    constraints = plan.get("constraints", []) if isinstance(plan, dict) else []

    for constraint in constraints:
        if not isinstance(constraint, dict):
            constraint_results.append({
                "constraint_id": None,
                "statement": None,
                "status": "not_evaluable",
                "reason": "Constraint is not an object.",
            })
            continue

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

    observed_step_ids: set[str] = {
        step_id
        for event in events
        if isinstance(event, dict)
        and isinstance(step_id := event.get("step_id"), str)
        and step_id
        and _is_observed_event(event)
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

    # A failure does not establish causality.
    allowed_conclusions = {
        "undetermined",
        "intervention_supported",
        "not_supported",
    }

    conclusion = (
        causal_conclusion
        if causal_conclusion in allowed_conclusions
        else "undetermined"
    )

    return {
        "plan_validation": plan_validation,
        "trace_event_count": len(events),
        "observed_event_count": sum(
            1 for event in events if _is_observed_event(event)
        ),
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
    known_step_ids: set[str] | None = None,
) -> dict:
    """Assess reported intervention results conservatively.

    known_step_ids is optional to remain compatible with callers that
    only pass the request payload. When provided, it validates the
    candidate step against the saved plan.
    """
    payload = payload if isinstance(payload, dict) else {}

    candidate = payload.get("candidate_step_id")
    executed = payload.get("intervention_was_executed", False)
    controls = payload.get("conditions_held_constant") or []
    source = payload.get("evidence_source") or ""
    baseline = payload.get("baseline_outcome")
    intervention = payload.get("intervention_outcome")

    reasons = []

    if not candidate:
        reasons.append("No candidate step was supplied.")
    elif known_step_ids is not None and candidate not in known_step_ids:
        reasons.append("Candidate step is not in the saved plan.")

    if executed is not True:
        reasons.append("The intervention was not confirmed as executed.")

    if not controls:
        reasons.append("No controlled conditions were recorded.")

    if not isinstance(source, str) or not source.strip():
        reasons.append("No evidence source was supplied.")

    if not isinstance(baseline, str) or not baseline.strip():
        reasons.append("A recorded baseline outcome is missing.")

    if not isinstance(intervention, str) or not intervention.strip():
        reasons.append("A recorded intervention outcome is missing.")

    if reasons:
        return {
            "status": "undetermined",
            "reasons": reasons,
            "candidate_step_id": candidate,
            "human_review_required": True,
            "causal_claim_permitted": False,
        }

    # Different reported strings are not automatically proof of a
    # meaningful change. This only records that the observations differ.
    if (
        isinstance(baseline, str)
        and isinstance(intervention, str)
        and baseline.strip() != intervention.strip()
    ):
        status = "intervention_supported"
        explanation = (
            "The reported baseline and intervention outcomes differ. "
            "This supports a causal hypothesis but does not prove causality."
        )
    else:
        status = "not_supported"
        explanation = (
            "The reported baseline and intervention outcomes are identical. "
            "The observations do not support a change under the reported "
            "conditions, but this does not rule out causality."
        )

    return {
        "status": status,
        "explanation": explanation,
        "candidate_step_id": candidate,
        "baseline_outcome": baseline,
        "intervention_outcome": intervention,
        "conditions_held_constant": controls,
        "evidence_source": source,
        "human_review_required": True,
        "causal_claim_permitted": False,
    }


def assess_retest(plan: dict, events: list[dict]) -> dict:
    """Assess revised-plan retest evidence without claiming proof."""
    events = events if isinstance(events, list) else []

    structure = validate_plan_structure(
        plan,
        min_steps=1,
        max_steps=20,
    )

    verification = verify_run(plan, events)

    steps = plan.get("steps", []) if isinstance(plan, dict) else []

    known_steps: set[str] = {
        step["id"]
        for step in steps
        if isinstance(step, dict)
        and isinstance(step.get("id"), str)
        and step.get("id")
    }

    observed_step_ids: set[str] = {
        event["step_id"]
        for event in events
        if isinstance(event, dict)
        and isinstance(event.get("step_id"), str)
        and event.get("step_id")
        and _is_observed_event(event)
    }

    unobserved_steps = sorted(known_steps - observed_step_ids)

    constraint_failures = [
        item
        for item in verification["constraint_results"]
        if item.get("status") == "failed"
    ]

    unevaluable_constraints = [
        item
        for item in verification["constraint_results"]
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
            "Semantic constraints require human or domain-expert review.",
            "Unobserved steps cannot be assumed to have succeeded.",
        ],
    }