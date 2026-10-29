
"""SQLite persistence with workflow lineage and backward-compatible migration."""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
raw_path = Path(os.getenv("NSCR_DB_PATH", "data/nscr.sqlite3"))
DB_PATH = raw_path if raw_path.is_absolute() else ROOT / raw_path


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            task TEXT NOT NULL,
            model TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            diagnosis_json TEXT,
            repair_json TEXT,
            issue TEXT NOT NULL DEFAULT '',
            trace_json TEXT,
            verification_json TEXT,
            workflow_id TEXT,
            parent_run_id TEXT,
            phase TEXT NOT NULL DEFAULT 'plan'
        )
    """)

    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(runs)").fetchall()
    }

    migrations = {
        "trace_json": "TEXT",
        "verification_json": "TEXT",
        "workflow_id": "TEXT",
        "parent_run_id": "TEXT",
        "phase": "TEXT NOT NULL DEFAULT 'plan'",
    }

    for name, sql_type in migrations.items():
        if name not in columns:
            conn.execute(
                f"ALTER TABLE runs ADD COLUMN {name} {sql_type}"
            )

    # Existing runs become their own workflows. No ancestry is invented.
    conn.execute("""
        UPDATE runs
        SET workflow_id = id
        WHERE workflow_id IS NULL OR workflow_id = ''
    """)
    conn.commit()
    return conn


def _decode_row(row):
    if not row:
        return None

    data = dict(row)

    for key in (
        "plan_json",
        "diagnosis_json",
        "repair_json",
        "trace_json",
        "verification_json",
    ):
        target = key.removesuffix("_json")
        value = data.pop(key, None)
        data[target] = json.loads(value) if value else None

    return data


def save_run(
    task,
    model,
    plan,
    diagnosis=None,
    repair=None,
    issue="",
    trace=None,
    verification=None,
    workflow_id=None,
    parent_run_id=None,
    phase=None,
):
    run_id = str(uuid.uuid4())

    if parent_run_id and not workflow_id:
        parent = get_run(parent_run_id)
        workflow_id = parent.get("workflow_id") if parent else None

    workflow_id = workflow_id or run_id

    if not phase:
        if verification and verification.get("retest_assessment"):
            phase = "retest"
        elif verification and verification.get("causal_analysis"):
            phase = "causal_analysis"
        elif verification and verification.get("intervention_assessment"):
            phase = "counterfactual"
        elif repair is not None:
            phase = "repair_proposal"
        elif diagnosis is not None:
            phase = "diagnosis"
        elif trace is not None:
            phase = "trace"
        else:
            phase = "plan"

    conn = _connect()
    try:
        conn.execute("""
            INSERT INTO runs (
                id, created_at, task, model, plan_json, diagnosis_json,
                repair_json, issue, trace_json, verification_json,
                workflow_id, parent_run_id, phase
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            run_id,
            datetime.now(timezone.utc).isoformat(),
            task,
            model,
            json.dumps(plan, ensure_ascii=False),
            json.dumps(diagnosis, ensure_ascii=False)
            if diagnosis is not None else None,
            json.dumps(repair, ensure_ascii=False)
            if repair is not None else None,
            issue or "",
            json.dumps(trace, ensure_ascii=False)
            if trace is not None else None,
            json.dumps(verification, ensure_ascii=False)
            if verification is not None else None,
            workflow_id,
            parent_run_id,
            phase,
        ))
        conn.commit()
    finally:
        conn.close()

    return run_id


def get_run(run_id):
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
    finally:
        conn.close()

    return _decode_row(row)


def get_workflow_runs(workflow_id):
    """Return every saved run in one workflow, oldest first."""
    conn = _connect()
    try:
        rows = conn.execute("""
            SELECT *
            FROM runs
            WHERE workflow_id = ?
            ORDER BY created_at ASC
        """, (workflow_id,)).fetchall()
    finally:
        conn.close()

    return [_decode_row(row) for row in rows]


def list_runs(limit=50):
    conn = _connect()
    try:
        rows = conn.execute("""
            SELECT
                id, created_at, task, model, diagnosis_json, repair_json,
                trace_json, verification_json, workflow_id, parent_run_id, phase
            FROM runs
            ORDER BY created_at DESC
            LIMIT ?
        """, (max(1, min(int(limit), 200)),)).fetchall()
    finally:
        conn.close()

    output = []

    for row in rows:
        data = dict(row)
        data["diagnosed"] = bool(data.pop("diagnosis_json"))
        data["repaired"] = bool(data.pop("repair_json"))
        data["has_trace"] = bool(data.pop("trace_json"))

        raw_verification = data.pop("verification_json")
        verification = (
            json.loads(raw_verification)
            if raw_verification else None
        )

        data["verified"] = bool(verification)
        data["retest_status"] = (
            (verification or {})
            .get("retest_assessment", {})
            .get("status")
        )

        output.append(data)

    return output
