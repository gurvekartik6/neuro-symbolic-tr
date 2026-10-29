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
    model_config = ConfigDict(extra="forbid")


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
    assumptions: list[str] = Field(default_factory=list, max_length=100)
    steps: list[PlanStep] = Field(min_length=1, max_length=20)
    constraints: list[Constraint] = Field(default_factory=list, max_length=100)
    uncertainty_notes: list[str] = Field(default_factory=list, max_length=100)


class TraceEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=80)
    step_id: str | None = Field(default=None, max_length=40)
    timestamp: datetime | None = None
    status: Literal[
        "succeeded",
        "failed",
        "skipped",
        "unknown",
    ] = "unknown"
    input_observation: str | None = Field(default=None, max_length=5000)
    output_observation: str | None = Field(default=None, max_length=5000)
    source: str = Field(min_length=1, max_length=1000)
    preconditions_met: bool | None = None
    postconditions_met: bool | None = None

    @model_validator(mode="after")
    def reject_template_as_confirmed_evidence(self):
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
    run_id: str
    events: list[TraceEvent] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def unique_event_ids(self):
        ids = [event.event_id for event in self.events]

        if len(ids) != len(set(ids)):
            raise ValueError(
                "event_id values must be unique within a trace."
            )

        return self


class DiagnoseRequest(StrictModel):
    run_id: str
    issue: str = Field(default="", max_length=3000)


class RepairRequest(StrictModel):
    run_id: str


class DiagnosisResponse(StrictModel):
    candidate_step_id: str | None
    root_cause_hypothesis: str
    evidence: list[str] = Field(default_factory=list)
    alternative_causes: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    repair_action: str
    requires_human_confirmation: bool
    limitations: list[str] = Field(default_factory=list)
    evidence_event_ids: list[str] = Field(default_factory=list)
    causal_status: Literal["hypothesis", "undetermined"] = "hypothesis"


class RepairResponse(StrictModel):
    explanation: str
    revised_steps: list[PlanStep] = Field(min_length=1, max_length=20)
    changed_step_ids: list[str]
    preserved_step_ids: list[str]
    verification_checks: list[str]
    needs_human_confirmation: bool


class CounterfactualRequest(StrictModel):
    run_id: str
    candidate_step_id: str = Field(min_length=1, max_length=40)
    intervention_description: str = Field(min_length=5, max_length=2000)
    baseline_outcome: str = Field(min_length=1, max_length=2000)
    intervention_outcome: str = Field(min_length=1, max_length=2000)
    conditions_held_constant: list[str] = Field(default_factory=list, max_length=100)
    evidence_source: str = Field(min_length=1, max_length=500)
    intervention_was_executed: bool = False


class RetestRequest(StrictModel):
    source_run_id: str
    revised_plan: PlanResponse
    events: list[TraceEvent] = Field(min_length=1, max_length=500)
    original_issue: str = Field(min_length=1, max_length=3000)

    @model_validator(mode="after")
    def unique_event_ids(self):
        ids = [event.event_id for event in self.events]

        if len(ids) != len(set(ids)):
            raise ValueError(
                "event_id values must be unique within a retest."
            )

        return self