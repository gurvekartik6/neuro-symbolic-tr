
"""NS-CR FastAPI application with automatic API execution and evidence capture."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Sequence

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .gemini_service import GeminiService
from .execution import execute_plan, list_tools
from .schemas import (
    TraceSubmission,
    CounterfactualRequest,
    RetestRequest,
    DiagnoseRequest,
    RepairRequest,
)
from .store import save_run, get_run, list_runs, get_workflow_runs
from .verification import (
    verify_run,
    intervention_assessment,
    assess_retest,
    validate_plan_structure,
)

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


app = FastAPI(
    title="NS-CR Research Lab",
    version="1.6.0",
    description=(
        "Evidence-backed planning, automatic HTTP API execution, "
        "trace collection, diagnosis, repair, retest, and causal analysis."
    ),
)

app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


class PlanRequest(BaseModel):
    task: str = Field(min_length=10, max_length=6000)


class CausalAnalysisRequest(BaseModel):
    run_id: str = Field(min_length=1, max_length=100)


class ExecutionBinding(BaseModel):
    step_id: str = Field(min_length=1, max_length=40)
    tool_name: str = Field(min_length=1, max_length=64)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ExecuteRequest(BaseModel):
    run_id: str = Field(min_length=1, max_length=100)
    bindings: list[ExecutionBinding] = Field(
        default_factory=list,
        max_length=20,
    )
    confirm_external_actions: bool = False


def service():
    try:
        return GeminiService()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _ensure_run(run_id: str) -> dict:
    run = get_run(run_id)

    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")

    return run


def _serialize_events(events) -> list[dict]:
    return [
        event.model_dump(mode="json")
        if hasattr(event, "model_dump")
        else event
        for event in events
    ]


def _step_ids(plan: dict) -> set[str]:
    return {
        step["id"]
        for step in plan.get("steps", [])
        if step.get("id")
    }


def _unknown_step_ids(
    events: list[dict],
    valid_ids: set[str],
) -> list[str]:
    return sorted({
        event["step_id"]
        for event in events
        if event.get("step_id") and event["step_id"] not in valid_ids
    })


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _is_actual_trace_event(event: dict) -> bool:
    """Exclude empty placeholders from evidence-based diagnosis."""
    if event.get("source") == "generated_template_pending_observation":
        return False

    if event.get("status", "unknown") == "unknown":
        return False

    return any(
        event.get(field) is not None and event.get(field) != ""
        for field in (
            "input_observation",
            "output_observation",
            "preconditions_met",
            "postconditions_met",
        )
    )


def _find_saved_intervention(
    workflow_runs: Sequence[Mapping[str, Any] | None],
):
    """Find the latest saved intervention assessment."""
    for workflow_run in reversed(workflow_runs):
        if workflow_run is None:
            continue

        verification = workflow_run.get("verification") or {}
        saved = verification.get("intervention_assessment")

        if saved:
            return saved

        analysis = verification.get("causal_analysis") or {}
        saved = analysis.get("saved_intervention_assessment")

        if saved:
            return saved

    return None


@app.get("/", response_class=HTMLResponse)
def home():
    return (
        ROOT / "static" / "index.html"
    ).read_text(encoding="utf-8")


@app.get("/api/health")
def health():
    key = os.getenv("GEMINI_API_KEY", "").strip()

    return {
        "status": "ok",
        "gemini_key_configured": bool(
            key and key != "replace_with_your_key"
        ),
        "model": os.getenv(
            "GEMINI_MODEL",
            "gemini-3.8-flash",
        ).strip() or "gemini-3.8-flash",
        "streaming": True,
        "database": "SQLite",
        "workflow_lineage": True,
        "automatic_causal_analysis": True,
        "automatic_api_execution": True,
        "causal_verification": (
            "Recorded API responses and observations are evidence, "
            "but are not independently authenticated."
        ),
    }


# -------------------------------------------------------------------
# Step 02: Planning
# -------------------------------------------------------------------

@app.post("/api/plan")
def create_plan(req: PlanRequest):
    gemini = service()

    try:
        plan = gemini.plan(req.task)
        structure = validate_plan_structure(plan, 3, 12)

        if not structure["valid"]:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Generated plan failed structural validation.",
                    "validation": structure,
                },
            )

        run_id = save_run(
            req.task,
            gemini.model,
            plan,
            phase="plan",
        )

        return {
            "run_id": run_id,
            "workflow_id": run_id,
            "model": gemini.model,
            "task": req.task,
            "plan": plan,
            "notice": (
                "Plan generated by Gemini. "
                "No real-world actions have been executed yet."
            ),
        }

    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/plan/stream")
def create_plan_stream(req: PlanRequest):
    def generate():
        try:
            gemini = GeminiService()

            yield _sse({
                "type": "status",
                "message": "Request accepted. Connecting to Gemini…",
            })

            for event in gemini.stream_plan(req.task):
                if event.get("type") != "result":
                    yield _sse(event)
                    continue

                plan = event["plan"]
                structure = validate_plan_structure(plan, 3, 12)

                if not structure["valid"]:
                    yield _sse({
                        "type": "error",
                        "message": (
                            "Generated plan failed structural validation: "
                            + "; ".join(structure["errors"])
                        ),
                    })
                    return

                run_id = save_run(
                    req.task,
                    gemini.model,
                    plan,
                    phase="plan",
                )

                yield _sse({
                    "type": "complete",
                    "run_id": run_id,
                    "workflow_id": run_id,
                    "model": gemini.model,
                    "task": req.task,
                    "plan": plan,
                    "notice": (
                        "Plan generated. No external actions were executed."
                    ),
                })

        except Exception as exc:
            yield _sse({
                "type": "error",
                "message": str(exc) or type(exc).__name__,
            })

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# -------------------------------------------------------------------
# Step 03: Automatic execution and trace capture
# -------------------------------------------------------------------

@app.get("/api/execution/tools")
def execution_tools():
    """List configured tools without exposing API keys or full URLs."""
    try:
        tools = list_tools()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "configured": bool(tools),
        "tools": tools,
        "notice": (
            "Only server-configured HTTPS API tools are available. "
            "Credentials remain on the server."
        ),
    }


@app.post("/api/execute")
def execute(req: ExecuteRequest):
    """Execute configured API calls and automatically persist their trace."""
    run = _ensure_run(req.run_id)

    try:
        events = execute_plan(
            run["plan"],
            [
                binding.model_dump(mode="json")
                for binding in req.bindings
            ],
            confirm_external_actions=req.confirm_external_actions,
        )

    except (RuntimeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    unknown = _unknown_step_ids(events, _step_ids(run["plan"]))

    if unknown:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "The execution engine returned unknown step IDs.",
                "unknown_step_ids": unknown,
            },
        )

    report = verify_run(run["plan"], events)
    workflow_id = run.get("workflow_id") or run["id"]

    new_id = save_run(
        run["task"],
        run["model"],
        run["plan"],
        diagnosis=run.get("diagnosis"),
        repair=run.get("repair"),
        issue=run.get("issue", ""),
        trace=events,
        verification=report,
        workflow_id=workflow_id,
        parent_run_id=run["id"],
        phase="execution",
    )

    return {
        "run_id": new_id,
        "source_run_id": run["id"],
        "workflow_id": workflow_id,
        "trace_event_count": len(events),
        "trace_events": events,
        "verification": report,
        "notice": (
            "Trace events were captured automatically from configured API calls. "
            "Unbound or blocked steps are recorded as skipped. An HTTP success "
            "does not independently prove a downstream real-world effect."
        ),
    }


# -------------------------------------------------------------------
# Optional legacy endpoint: accept an externally collected trace
# -------------------------------------------------------------------

@app.post("/api/trace")
def submit_trace(req: TraceSubmission):
    run = _ensure_run(req.run_id)
    events = _serialize_events(req.events)
    unknown = _unknown_step_ids(events, _step_ids(run["plan"]))
    report = verify_run(run["plan"], events)

    new_id = save_run(
        run["task"],
        run["model"],
        run["plan"],
        diagnosis=run.get("diagnosis"),
        repair=run.get("repair"),
        issue=run.get("issue", ""),
        trace=events,
        verification=report,
        workflow_id=run.get("workflow_id"),
        parent_run_id=run["id"],
        phase="trace",
    )

    return {
        "run_id": new_id,
        "source_run_id": run["id"],
        "workflow_id": run.get("workflow_id"),
        "trace_event_count": len(events),
        "unknown_step_ids": unknown,
        "verification": report,
        "notice": (
            "This legacy endpoint accepts submitted events. "
            "For automatic API execution, use POST /api/execute."
        ),
    }


# -------------------------------------------------------------------
# Verification
# -------------------------------------------------------------------

@app.post("/api/verify")
def verify(req: DiagnoseRequest):
    run = _ensure_run(req.run_id)

    if not run.get("trace"):
        raise HTTPException(
            status_code=400,
            detail="Execute configured APIs or provide a trace before verification.",
        )

    report = verify_run(run["plan"], run["trace"])

    new_id = save_run(
        run["task"],
        run["model"],
        run["plan"],
        diagnosis=run.get("diagnosis"),
        repair=run.get("repair"),
        issue=req.issue or run.get("issue", ""),
        trace=run["trace"],
        verification=report,
        workflow_id=run.get("workflow_id"),
        parent_run_id=run["id"],
        phase="verification",
    )

    return {
        "run_id": new_id,
        "source_run_id": run["id"],
        "workflow_id": run.get("workflow_id"),
        "verification": report,
        "notice": (
            "Verification checks recorded evidence; it does not prove "
            "the evidence is complete or truthful."
        ),
    }


# -------------------------------------------------------------------
# Step 04: Diagnosis
# -------------------------------------------------------------------

@app.post("/api/diagnose")
def diagnose(req: DiagnoseRequest):
    run = _ensure_run(req.run_id)
    trace = run.get("trace") or []

    actual_events = [
        event for event in trace
        if _is_actual_trace_event(event)
    ]

    verification = (
        verify_run(run["plan"], trace)
        if trace
        else {
            "trace_event_count": 0,
            "causal_conclusion": "undetermined",
            "notes": ["No execution trace was supplied."],
        }
    )

    if not actual_events:
        diagnosis = {
            "candidate_step_id": None,
            "root_cause_hypothesis": (
                "Insufficient execution evidence to localize a root cause."
            ),
            "evidence": [],
            "alternative_causes": [],
            "confidence": 0.0,
            "repair_action": (
                "Execute configured APIs or collect genuine observations "
                "before requesting a diagnosis."
            ),
            "requires_human_confirmation": True,
            "limitations": [
                "No non-template event with a known status and recorded "
                "observation was supplied."
            ],
            "evidence_event_ids": [],
            "causal_status": "undetermined",
        }

    else:
        gemini = service()

        try:
            diagnosis = gemini.diagnose(
                run["task"],
                run["plan"],
                trace,
                req.issue or run.get("issue", ""),
                verification,
            )
        except RuntimeError as exc:
            raise HTTPException(
                status_code=502,
                detail=str(exc),
            ) from exc

    issue = req.issue or run.get("issue", "")

    new_id = save_run(
        run["task"],
        run["model"],
        run["plan"],
        diagnosis=diagnosis,
        repair=run.get("repair"),
        issue=issue,
        trace=trace or None,
        verification=verification,
        workflow_id=run.get("workflow_id"),
        parent_run_id=run["id"],
        phase="diagnosis",
    )

    return {
        "run_id": new_id,
        "source_run_id": run["id"],
        "workflow_id": run.get("workflow_id"),
        "diagnosis": diagnosis,
        "verification": verification,
        "notice": (
            "A diagnosis is a hypothesis. Model confidence and event order "
            "alone are not proof of causality."
        ),
    }


# -------------------------------------------------------------------
# Step 06: Intervention / counterfactual assessment
# -------------------------------------------------------------------

@app.post("/api/counterfactual")
def counterfactual(req: CounterfactualRequest):
    run = _ensure_run(req.run_id)

    assessment = intervention_assessment(
        req.model_dump(mode="json"),
        _step_ids(run["plan"]),
    )

    report = verify_run(
        run["plan"],
        run.get("trace") or [],
        causal_conclusion=assessment["status"],
    )

    result = {
        "intervention": req.model_dump(mode="json"),
        "assessment": assessment,
        "verification": report,
        "notice": (
            "This evaluates reported intervention observations. "
            "NS-CR did not execute the intervention or authenticate its source."
        ),
    }

    new_id = save_run(
        run["task"],
        run["model"],
        run["plan"],
        diagnosis=run.get("diagnosis"),
        repair=run.get("repair"),
        issue=run.get("issue", ""),
        trace=run.get("trace"),
        verification={
            **report,
            "intervention_assessment": result,
        },
        workflow_id=run.get("workflow_id"),
        parent_run_id=run["id"],
        phase="counterfactual",
    )

    return {
        "run_id": new_id,
        "source_run_id": run["id"],
        "workflow_id": run.get("workflow_id"),
        **result,
    }


# -------------------------------------------------------------------
# Step 06: Automatic causal-analysis report
# -------------------------------------------------------------------

@app.post("/api/causal-analysis")
def causal_analysis(req: CausalAnalysisRequest):
    """Analyze saved workflow evidence without inventing missing observations."""
    selected = _ensure_run(req.run_id)
    workflow_id = selected.get("workflow_id") or selected["id"]
    workflow_runs = get_workflow_runs(workflow_id)

    if not workflow_runs:
        workflow_runs = [selected]

    diagnosis_run = next(
        (
            item for item in reversed(workflow_runs)
            if item is not None and item.get("diagnosis")
        ),
        None,
    )

    trace_run = next(
        (
            item for item in reversed(workflow_runs)
            if item is not None and item.get("trace") is not None
        ),
        None,
    )

    diagnosis = diagnosis_run.get("diagnosis") if diagnosis_run else None
    trace = (
        trace_run.get("trace") or []
        if trace_run else []
    )

    actual_events = [
        event for event in trace
        if _is_actual_trace_event(event)
    ]

    saved_intervention = _find_saved_intervention(workflow_runs)
    intervention_payload = None
    intervention_assessment_saved = None

    if saved_intervention:
        intervention_payload = saved_intervention.get("intervention") or {}
        intervention_assessment_saved = (
            saved_intervention.get("assessment") or saved_intervention
        )

    missing_evidence = []

    if not diagnosis:
        missing_evidence.append({
            "item": "diagnosis",
            "reason": "No saved diagnosis exists in this workflow.",
            "action": "Execute APIs and run diagnosis against the saved trace.",
        })

    if not trace:
        missing_evidence.append({
            "item": "execution_trace",
            "reason": "No saved execution trace exists in this workflow.",
            "action": "Execute configured APIs or collect real observations.",
        })
    elif not actual_events:
        missing_evidence.append({
            "item": "actual_trace_observations",
            "reason": "No trace event has both a known status and observation.",
            "action": "Collect actual execution observations; do not invent outcomes.",
        })

    if not intervention_payload:
        missing_evidence.append({
            "item": "intervention_evidence",
            "reason": "No saved intervention assessment was found.",
            "action": (
                "Only if an intervention was actually performed, record its "
                "baseline outcome, post-intervention outcome, controlled "
                "conditions, and evidence source."
            ),
        })

        causal_status = "undetermined"
        conclusion = (
            "No saved intervention comparison was found. The causal effect "
            "remains undetermined."
        )

    else:
        executed = intervention_payload.get(
            "intervention_was_executed",
            False,
        )

        required = {
            "candidate_step_id": "candidate step ID",
            "intervention_description": "intervention description",
            "baseline_outcome": "baseline outcome",
            "intervention_outcome": "post-intervention outcome",
            "evidence_source": "evidence source",
        }

        for field, label in required.items():
            if not str(intervention_payload.get(field) or "").strip():
                missing_evidence.append({
                    "item": field,
                    "reason": f"The saved record is missing the {label}.",
                    "action": "Supply this only when supported by actual evidence.",
                })

        if not executed:
            missing_evidence.append({
                "item": "executed_intervention_evidence",
                "reason": "The saved record does not confirm execution.",
                "action": "Do not mark the intervention executed unless it happened.",
            })

        if not intervention_payload.get("conditions_held_constant"):
            missing_evidence.append({
                "item": "controlled_conditions",
                "reason": "No controlled conditions were recorded.",
                "action": "Record relevant conditions actually held constant.",
            })

        saved_status = (
            intervention_assessment_saved.get("status")
            if intervention_assessment_saved else None
        )

        complete = (
            executed
            and all(
                str(intervention_payload.get(field) or "").strip()
                for field in required
            )
            and bool(intervention_payload.get("conditions_held_constant"))
        )

        if not complete:
            causal_status = "undetermined"
            conclusion = (
                "The saved intervention record is incomplete or does not "
                "confirm execution. The causal effect remains undetermined."
            )

        elif saved_status == "intervention_supported":
            causal_status = "intervention_supported"
            conclusion = (
                "The recorded outcomes differ under the reported intervention. "
                "This supports a possible effect but does not prove causality "
                "or independently authenticate the evidence."
            )

        elif saved_status == "not_supported":
            causal_status = "not_supported"
            conclusion = (
                "The recorded outcomes did not differ. This comparison does "
                "not support an effect for the reported intervention."
            )

        else:
            causal_status = "undetermined"
            conclusion = (
                "The saved intervention assessment does not support a firm "
                "conclusion. Human review is required."
            )

    report = (
        verify_run(
            selected["plan"],
            trace,
            causal_conclusion=causal_status,
        )
        if trace
        else {
            "trace_event_count": 0,
            "causal_conclusion": causal_status,
            "notes": ["No saved execution trace was available."],
        }
    )

    analysis = {
        "status": causal_status,
        "conclusion": conclusion,
        "workflow_id": workflow_id,
        "evidence_summary": {
            "workflow_runs_considered": len(workflow_runs),
            "diagnosis_run_id": (
                diagnosis_run["id"] if diagnosis_run else None
            ),
            "trace_run_id": (
                trace_run["id"] if trace_run else None
            ),
            "saved_trace_event_count": len(trace),
            "actual_observation_event_count": len(actual_events),
            "saved_intervention_assessment": (
                intervention_assessment_saved
            ),
        },
        "diagnosis": diagnosis,
        "trace_events": trace,
        "missing_evidence": missing_evidence,
        "verification": report,
        "human_review_required": True,
        "limitations": [
            "Only records saved in this workflow were considered.",
            "API responses and user-supplied evidence are not independently authenticated.",
            "A diagnosis hypothesis or event order alone does not establish causation.",
            "NS-CR does not automatically perform causal interventions.",
        ],
    }

    new_id = save_run(
        selected["task"],
        selected["model"],
        selected["plan"],
        diagnosis=diagnosis,
        repair=selected.get("repair"),
        issue=selected.get("issue", ""),
        trace=trace if trace else None,
        verification={
            "causal_analysis": analysis,
            **report,
        },
        workflow_id=workflow_id,
        parent_run_id=selected["id"],
        phase="causal_analysis",
    )

    return {
        "run_id": new_id,
        "source_run_id": selected["id"],
        **analysis,
    }


# -------------------------------------------------------------------
# Step 05: Repair proposal
# -------------------------------------------------------------------

@app.post("/api/repair")
def repair(req: RepairRequest):
    run = _ensure_run(req.run_id)

    if not run.get("diagnosis"):
        raise HTTPException(
            status_code=400,
            detail="Diagnose the run before requesting a repair.",
        )

    gemini = service()

    try:
        repair_data = gemini.repair(
            run["task"],
            run["plan"],
            run["diagnosis"],
        )

        revised_plan = {
            **run["plan"],
            "steps": repair_data.get("revised_steps", []),
        }

        structure = validate_plan_structure(revised_plan, 1, 20)

        if not structure["valid"]:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Repair plan failed structural validation.",
                    "validation": structure,
                },
            )

        new_id = save_run(
            run["task"],
            run["model"],
            run["plan"],
            diagnosis=run["diagnosis"],
            repair=repair_data,
            issue=run.get("issue", ""),
            trace=run.get("trace"),
            verification=run.get("verification"),
            workflow_id=run.get("workflow_id"),
            parent_run_id=run["id"],
            phase="repair_proposal",
        )

        return {
            "run_id": new_id,
            "source_run_id": run["id"],
            "workflow_id": run.get("workflow_id"),
            "repair": repair_data,
            "revised_plan": revised_plan,
            "notice": (
                "Repair proposal only. It has not been executed "
                "or outcome-verified."
            ),
        }

    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# -------------------------------------------------------------------
# Step 07: Retest evidence
# -------------------------------------------------------------------

@app.post("/api/retest")
def retest(req: RetestRequest):
    source = _ensure_run(req.source_run_id)

    if not source.get("repair"):
        raise HTTPException(
            status_code=400,
            detail=(
                "The source run has no saved repair proposal. "
                "Generate a repair proposal before retesting."
            ),
        )

    revised_plan = req.revised_plan.model_dump(mode="json")
    events = _serialize_events(req.events)
    unknown = _unknown_step_ids(events, _step_ids(revised_plan))

    if unknown:
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    "Retest events reference steps absent from the revised plan."
                ),
                "unknown_step_ids": unknown,
            },
        )

    assessment = assess_retest(revised_plan, events)
    verification = {
        "retest_assessment": assessment,
        "source_run_id": req.source_run_id,
    }

    new_id = save_run(
        source["task"],
        source["model"],
        revised_plan,
        diagnosis=source.get("diagnosis"),
        repair=source.get("repair"),
        issue=req.original_issue,
        trace=events,
        verification=verification,
        workflow_id=source.get("workflow_id"),
        parent_run_id=source["id"],
        phase="retest",
    )

    return {
        "run_id": new_id,
        "source_run_id": source["id"],
        "workflow_id": source.get("workflow_id"),
        "revised_plan": revised_plan,
        "retest": assessment,
        "notice": (
            "Retest evidence was checked against the revised plan. "
            "NS-CR did not execute the repair or independently authenticate "
            "observations."
        ),
    }


# -------------------------------------------------------------------
# Step 08: Workflow history
# -------------------------------------------------------------------

@app.get("/api/runs")
def runs():
    return {"runs": list_runs()}


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    return _ensure_run(run_id)
