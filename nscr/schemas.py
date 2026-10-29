from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PlanStep(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    action: str = Field(min_length=1)
    rationale: str
    expected_result: str
    depends_on: list[str] = Field(default_factory=list)
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
    id: str
    statement: str
    kind: Literal["hard", "soft", "semantic"]
    check_method: str
    relevant_step_ids: list[str] = Field(default_factory=list)
    rule: ConstraintRule | None = None


class PlanResponse(StrictModel):
    task_summary: str
    assumptions: list[str] = Field(default_factory=list)
    steps: list[PlanStep]
    constraints: list[Constraint] = Field(default_factory=list)
    uncertainty_notes: list[str] = Field(default_factory=list)


class TraceEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=80)
    step_id: str | None = None
    timestamp: datetime | None = None
    status: Literal["succeeded", "failed", "skipped", "unknown"] = "unknown"
    input_observation: str | None = None
    output_observation: str | None = None
    source: str = Field(min_length=1)
    preconditions_met: bool | None = None
    postconditions_met: bool | None = None


class TraceSubmission(StrictModel):
    run_id: str
    events: list[TraceEvent] = Field(min_length=1, max_length=500)


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
    revised_steps: list[PlanStep]
    changed_step_ids: list[str]
    preserved_step_ids: list[str]
    verification_checks: list[str]
    needs_human_confirmation: bool


class CounterfactualRequest(StrictModel):
    run_id: str
    candidate_step_id: str = Field(min_length=1)
    intervention_description: str = Field(min_length=5, max_length=2000)
    baseline_outcome: str = Field(min_length=1, max_length=2000)
    intervention_outcome: str = Field(min_length=1, max_length=2000)
    conditions_held_constant: list[str] = Field(default_factory=list)
    evidence_source: str = Field(min_length=1, max_length=500)
    intervention_was_executed: bool = False