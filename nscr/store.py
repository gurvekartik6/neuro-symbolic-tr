
"""SQLite persistence for NS-CR with workflow lineage and migrations."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid

from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent

raw_path = Path(os.getenv("NSCR_DB_PATH", "data/nscr.sqlite3"))
DB_PATH = raw_path if raw_path.is_absolute() else ROOT / raw_path


def _connect() -> sqlite3.Connection:
    """Create a database connection and apply backward-compatible migrations."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(
        DB_PATH,
        timeout=30,
    )

    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")

    conn.execute(
        """
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
        """
    )

    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(runs)").fetchall()
    }

    migrations = {
        "diagnosis_json": "TEXT",
        "repair_json": "TEXT",
        "issue": "TEXT NOT NULL DEFAULT ''",
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

    # Existing records become independent workflows when no lineage was saved.
    # No parent relationship is fabricated.
    conn.execute(
        """
        UPDATE runs
        SET workflow_id = id
        WHERE workflow_id IS NULL OR workflow_id = ''
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_runs_workflow_created
        ON runs(workflow_id, created_at)
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_runs_parent
        ON runs(parent_run_id)
        """
    )

    conn.commit()
    return conn


def _json_dump(value: Any) -> str | None:
    """Convert a value into JSON for storage."""
    if value is None:
        return None

    return json.dumps(
        value,
        ensure_ascii=False,
        default=str,
    )


def _json_load(value: str | None) -> Any:
    """Decode stored JSON without crashing on legacy or malformed values."""
    if value is None or value == "":
        return None

    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None


def _decode_row(row: sqlite3.Row | dict | None) -> dict | None:
    """Convert a database row into the public run representation."""
    if row is None:
        return None

    data = dict(row)

    json_columns = (
        "plan_json",
        "diagnosis_json",
        "repair_json",
        "trace_json",
        "verification_json",
    )

    for column in json_columns:
        target = column.removesuffix("_json")
        value = data.pop(column, None)
        data[target] = _json_load(value)

    return data


def save_run(
    task: str,
    model: str,
    plan: dict,
    diagnosis: dict | None = None,
    repair: dict | None = None,
    issue: str = "",
    trace: list | None = None,
    verification: dict | None = None,
    workflow_id: str | None = None,
    parent_run_id: str | None = None,
    phase: str | None = None,
) -> str:
    """
    Save a new immutable run record.

    Each operation creates a new run ID. Follow-up runs retain the original
    workflow ID and point to their parent run where supplied.
    """
    run_id = str(uuid.uuid4())

    # Preserve the parent's workflow when a caller supplies only the parent ID.
    if parent_run_id and not workflow_id:
        parent = get_run(parent_run_id)

        if parent:
            workflow_id = parent.get("workflow_id") or parent["id"]

    # An initial run starts its own workflow.
    workflow_id = workflow_id or run_id

    if not phase:
        if verification and verification.get("causal_analysis"):
            phase = "causal_analysis"
        elif verification and verification.get("retest_assessment"):
            phase = "retest"
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

    created_at = datetime.now(timezone.utc).isoformat()

    with _connect() as conn:
        # A parent must exist. This prevents broken lineage links.
        if parent_run_id:
            parent_exists = conn.execute(
                "SELECT 1 FROM runs WHERE id = ?",
                (parent_run_id,),
            ).fetchone()

            if not parent_exists:
                raise ValueError(
                    f"Parent run does not exist: {parent_run_id}"
                )

        conn.execute(
            """
            INSERT INTO runs (
                id,
                created_at,
                task,
                model,
                plan_json,
                diagnosis_json,
                repair_json,
                issue,
                trace_json,
                verification_json,
                workflow_id,
                parent_run_id,
                phase
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                created_at,
                task,
                model,
                _json_dump(plan),
                _json_dump(diagnosis),
                _json_dump(repair),
                issue or "",
                _json_dump(trace),
                _json_dump(verification),
                workflow_id,
                parent_run_id,
                phase,
            ),
        )

    return run_id


def get_run(run_id: str) -> dict | None:
    """Retrieve one complete run by its exact ID."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()

    return _decode_row(row)


def list_runs(limit: int = 50) -> list[dict]:
    """Return recent runs with decoded evidence and lineage metadata."""
    safe_limit = max(1, min(int(limit), 500))

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM runs
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()

    return [
        decoded
        for row in rows
        if (decoded := _decode_row(row)) is not None
    ]


def get_workflow_runs(workflow_id: str) -> list[dict]:
    """
    Return all runs belonging to a workflow, ordered chronologically.

    The workflow ID is a grouping identifier. Parent-run IDs separately
    represent the recorded lineage between individual runs.
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM runs
            WHERE workflow_id = ?
            ORDER BY created_at ASC, rowid ASC
            """,
            (workflow_id,),
        ).fetchall()

    return [
        decoded
        for row in rows
        if (decoded := _decode_row(row)) is not None
    ]


def get_child_runs(parent_run_id: str) -> list[dict]:
    """Return direct children of a saved run."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM runs
            WHERE parent_run_id = ?
            ORDER BY created_at ASC, rowid ASC
            """,
            (parent_run_id,),
        ).fetchall()

    return [
        decoded
        for row in rows
        if (decoded := _decode_row(row)) is not None
    ]


def get_workflow_summary(workflow_id: str) -> dict:
    """Build a summary from saved records without inventing missing evidence."""
    runs = get_workflow_runs(workflow_id)

    return {
        "workflow_id": workflow_id,
        "run_count": len(runs),
        "run_ids": [run["id"] for run in runs],
        "phases": [run.get("phase") for run in runs],
        "has_trace": any(bool(run.get("trace")) for run in runs),
        "has_diagnosis": any(
            bool(run.get("diagnosis")) for run in runs
        ),
        "has_repair": any(
            bool(run.get("repair")) for run in runs
        ),
        "has_verification": any(
            bool(run.get("verification")) for run in runs
        ),
    }


def delete_run(run_id: str) -> bool:
    """
    Delete a run only when it has no child runs.

    This prevents the removal of a parent from silently breaking lineage.
    """
    with _connect() as conn:
        children = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM runs
            WHERE parent_run_id = ?
            """,
            (run_id,),
        ).fetchone()["count"]

        if children:
            raise ValueError(
                "Cannot delete this run because child runs reference it."
            )

        cursor = conn.execute(
            "DELETE FROM runs WHERE id = ?",
            (run_id,),
        )

        return cursor.rowcount > 0


# Initialize the database when this module is imported.
# This creates the database and applies migrations without deleting existing data.
_connect().close()
