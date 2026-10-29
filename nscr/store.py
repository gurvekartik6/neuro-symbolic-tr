import json
import os
import sqlite3
import uuid
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
raw_path = Path(os.getenv("NSCR_DB_PATH", "data/nscr.sqlite3"))
DB_PATH = raw_path if raw_path.is_absolute() else ROOT / raw_path


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

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
            verification_json TEXT
        )
    """)

    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(runs)").fetchall()
    }

    if "trace_json" not in columns:
        conn.execute("ALTER TABLE runs ADD COLUMN trace_json TEXT")

    if "verification_json" not in columns:
        conn.execute("ALTER TABLE runs ADD COLUMN verification_json TEXT")

    conn.commit()
    return conn


def save_run(
    task,
    model,
    plan,
    diagnosis=None,
    repair=None,
    issue="",
    trace=None,
    verification=None,
):
    run_id = str(uuid.uuid4())

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO runs (
                id, created_at, task, model, plan_json, diagnosis_json,
                repair_json, issue, trace_json, verification_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                datetime.now(timezone.utc).isoformat(),
                task,
                model,
                json.dumps(plan, ensure_ascii=False),
                json.dumps(diagnosis, ensure_ascii=False)
                if diagnosis is not None else None,
                json.dumps(repair, ensure_ascii=False)
                if repair is not None else None,
                issue,
                json.dumps(trace, ensure_ascii=False)
                if trace is not None else None,
                json.dumps(verification, ensure_ascii=False)
                if verification is not None else None,
            ),
        )

    return run_id


def get_run(run_id):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()

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
        value = data.pop(key)
        data[target] = json.loads(value) if value else None

    return data


def list_runs(limit=30):
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, task, model, diagnosis_json, repair_json,
                   trace_json, verification_json
            FROM runs
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    output = []

    for row in rows:
        data = dict(row)
        data["diagnosed"] = bool(data.pop("diagnosis_json"))
        data["repaired"] = bool(data.pop("repair_json"))
        data["has_trace"] = bool(data.pop("trace_json"))
        data["verified"] = bool(data.pop("verification_json"))
        output.append(data)

    return output