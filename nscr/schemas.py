
"""Pydantic request and response schemas for NS-CR Research Lab.

These schemas validate data structures and input limits. They do not
independently authenticate user-supplied observations or prove causality.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
)


class StrictModel(BaseModel):
    """Reject unexpected fields to catch API payload mismatches."""

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# STEP 1–2: Task and plan structures
# ---------------------------------------------------------------------------

class PlanStep(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    action: str = Field(min_length=1, max_length=2000)
    rationale: str = Field(default="", max_length=3000)
    expected_result: str = Field(default="", max_length=2000)
    depends_on: list[str] = Field(default_factory=list, max_length=20)
    risk: Literal["low", "medium", "high"] = "medium"
    reversible: bool = True


class ConstraintRule(StrictModel):
    event_id: str | None = None

    field: Literal[
        "status",
        "preconditions_met",
        "postconditions_met",
        "input_observation",
        "output_observation",
    ]

    operator: Literal[
        "equals",
        "not_equals",
        "exists",
        "truthy",
        "contains",
    ]

    expected_value: str | bool | int | float | None = None


class Constraint(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    statement: str = Field(min_length=1, max_length=2000)

    kind: Literal["hard", "soft", "semantic"] = "semantic"

    check_method: str = Field(
        default="human_review",
        max_length=1000,
    )

    relevant_step_ids: list[str] = Field(default_factory=list)
    rule: ConstraintRule | None = None


class PlanResponse(StrictModel):
    task_summary: str = Field(min_length=1, max_length=3000)

    assumptions: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    steps: list[PlanStep] = Field(
        min_length=1,
        max_length=20,
    )

    constraints: list[Constraint] = Field(
        default_factory=list,
        max_length=100,
    )

    uncertainty_notes: list[str] = Field(
        default_factory=list,
        max_length=100,
    )


# ---------------------------------------------------------------------------
# STEP 3: Execution trace
# ---------------------------------------------------------------------------

class TraceEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=80)

    step_id: str | None = Field(
        default=None,
        max_length=40,
    )

    timestamp: datetime | None = None

    status: Literal[
        "succeeded",
        "failed",
        "skipped",
        "unknown",
    ] = "unknown"

    input_observation: str | None = Field(
        default=None,
        max_length=5000,
    )

    output_observation: str | None = Field(
        default=None,
        max_length=5000,
    )

    source: str = Field(
        min_length=1,
        max_length=1000,
    )

    preconditions_met: bool | None = None
    postconditions_met: bool | None = None

    @model_validator(mode="after")
    def validate_generated_template(self):
        """Prevent unobserved templates from being submitted as confirmed evidence."""

        if self.source == "generated_template_pending_observation":
            if self.status != "unknown":
                raise ValueError(
                    "Generated trace templates must retain status='unknown'."
                )

            if (
                self.input_observation is not None
                or self.output_observation is not None
            ):
                raise ValueError(
                    "Generated trace templates cannot contain observations."
                )

        return self


class TraceSubmission(StrictModel):
    run_id: str = Field(min_length=1, max_length=100)

    events: list[TraceEvent] = Field(
        min_length=1,
        max_length=500,
    )

    @model_validator(mode="after")
    def validate_unique_event_ids(self):
        event_ids = [
            event.event_id
            for event in self.events
        ]

        if len(event_ids) != len(set(event_ids)):
            raise ValueError(
                "event_id values must be unique within a trace."
            )

        return self


# ---------------------------------------------------------------------------
# STEP 4: Diagnosis
# ---------------------------------------------------------------------------

class DiagnoseRequest(StrictModel):
    run_id: str = Field(min_length=1, max_length=100)

    issue: str = Field(
        default="",
        max_length=3000,
    )


class DiagnosisResponse(StrictModel):
    candidate_step_id: str | None = None

    root_cause_hypothesis: str = Field(
        min_length=1,
        max_length=5000,
    )

    evidence: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    alternative_causes: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    confidence: float = Field(
        ge=0,
        le=1,
    )

    repair_action: str = Field(
        min_length=1,
        max_length=5000,
    )

    requires_human_confirmation: bool = True

    limitations: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    evidence_event_ids: list[str] = Field(
        default_factory=list,
        max_length=500,
    )

    causal_status: Literal[
        "hypothesis",
        "undetermined",
    ] = "hypothesis"


# ---------------------------------------------------------------------------
# STEP 5: Repair proposal
# ---------------------------------------------------------------------------

class RepairRequest(StrictModel):
    run_id: str = Field(min_length=1, max_length=100)


class RepairResponse(StrictModel):
    explanation: str = Field(
        min_length=1,
        max_length=5000,
    )

    revised_steps: list[PlanStep] = Field(
        min_length=1,
        max_length=20,
    )

    changed_step_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
    )

    preserved_step_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
    )

    verification_checks: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    needs_human_confirmation: bool = True


# ---------------------------------------------------------------------------
# STEP 6: Intervention and counterfactual evidence
# ---------------------------------------------------------------------------

class CounterfactualRequest(StrictModel):
    run_id: str = Field(
        min_length=1,
        max_length=100,
    )

    candidate_step_id: str = Field(
        min_length=1,
        max_length=40,
    )

    intervention_description: str = Field(
        min_length=5,
        max_length=2000,
    )

    baseline_outcome: str = Field(
        min_length=1,
        max_length=2000,
    )

    intervention_outcome: str = Field(
        min_length=1,
        max_length=2000,
    )

    conditions_held_constant: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    evidence_source: str = Field(
        min_length=1,
        max_length=500,
    )

    intervention_was_executed: bool = False

    @model_validator(mode="after")
    def validate_intervention_evidence(self):
        """Do not allow missing intervention status to be silently inferred."""

        if self.intervention_was_executed:
            if not self.baseline_outcome.strip():
                raise ValueError(
                    "A recorded baseline outcome is required."
                )

            if not self.intervention_outcome.strip():
                raise ValueError(
                    "A recorded intervention outcome is required."
                )

            if not self.evidence_source.strip():
                raise ValueError(
                    "An evidence source is required."
                )

        return self


# ---------------------------------------------------------------------------
# STEP 7: Retest evidence
# ---------------------------------------------------------------------------

class RetestRequest(StrictModel):
    source_run_id: str = Field(
        min_length=1,
        max_length=100,
    )

    revised_plan: PlanResponse

    events: list[TraceEvent] = Field(
        min_length=1,
        max_length=500,
    )

    original_issue: str = Field(
        min_length=1,
        max_length=3000,
    )

    @model_validator(mode="after")
    def validate_unique_event_ids(self):
        event_ids = [
            event.event_id
            for event in self.events
        ]

        if len(event_ids) != len(set(event_ids)):
            raise ValueError(
                "event_id values must be unique within a retest."
            )

        return self