# NS-CR Research Lab — evidence-backed Gemini implementation

FastAPI + HTML/CSS/JavaScript + SQLite application using Google's official `google-genai` SDK. Gemini is used for plan generation, trace-grounded diagnosis hypotheses, and repair proposals. Deterministic code validates dependency graphs and checks user-supplied evidence. The application does not seed demo scenarios, fabricate execution outcomes, or operate external systems.

## What changed in this version

- Diagnosis no longer treats a plan as an execution trace. Without actual trace events, the result is explicitly `undetermined`.
- Added a trace submission form and `POST /api/trace` for user-provided event evidence.
- Added deterministic checks for dependency cycles, duplicate event IDs, unknown step IDs, failed events, preconditions/postconditions, and supported machine-checkable constraint rules.
- Constraints without an explicit supported rule are marked `not_evaluable`, not silently treated as passed.
- Gemini diagnoses using the recorded trace and the independent verification report. Candidate step IDs and cited event IDs are checked against the supplied records; unsupported localization is downgraded to undetermined.
- Added `POST /api/counterfactual` to assess user-reported intervention outcomes. It never executes the intervention; an unexecuted or uncontrolled intervention remains undetermined.
- Repair plans are checked for duplicate/missing IDs, unknown dependencies, self-dependencies, and dependency cycles. They are still proposals, not verified recoveries.
- SQLite database path is anchored to the project directory by default; existing databases are migrated with trace and verification columns.
- Added unit tests for graph integrity, evidence checks, and conservative causal status.

## Important scientific limits

This prototype does **not** autonomously execute or replay actions. It cannot authenticate the truth or completeness of user-supplied observations. A changed outcome under a user-reported intervention can support a causal hypothesis but is not a formal causal proof. Gemini confidence is not calibrated. A research claim about accuracy or superiority requires real execution traces with independently established ground truth, baselines, and repeatable experiments.

## Requirements

- Python 3.10+
- Gemini API key from Google AI Studio
- Network access to install dependencies and call Gemini
- No Node.js, Docker, or separate database server required

## Windows setup

1. Extract the ZIP and open a terminal in the `nscr-gemini` folder.
2. Create `.env` and edit it:

```powershell
Copy-Item .env.example .env
notepad .env
```

3. Set `GEMINI_API_KEY` to your own key. Never paste it into chat or commit `.env`.
4. Install and start the application:

```powershell
py -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn nscr.main:app --reload
```

5. Open http://127.0.0.1:8000. API docs: http://127.0.0.1:8000/docs

## macOS/Linux setup

```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn nscr.main:app --reload
```

## Using the diagnosis workflow

1. Enter the real task and generate a plan.
2. Collect actual observations from your workflow, logs, or tool responses. The app does not create these records.
3. Paste them as a JSON array in **Record actual execution evidence**. Each event must include `event_id` and `source`; useful fields include `step_id`, `status` (`succeeded`, `failed`, `skipped`, `unknown`), `input_observation`, `output_observation`, `preconditions_met`, `postconditions_met`, and optional ISO timestamp.
4. Save and validate the trace. Inspect warnings and constraint results.
5. Run diagnosis. Gemini receives the supplied events and deterministic report. If evidence does not support localization, the result should remain undetermined.
6. Request a repair proposal if appropriate. Review it manually; it is not executed.

Do not enter fabricated event results to make the diagnosis run. If a field is unknown, leave it null or set status to `unknown` and record the uncertainty in the source/observations.

## Configuration

- `GEMINI_API_KEY`: required for planning, diagnosis with actual trace events, and repair proposals. Get a key from https://aistudio.google.com/app/apikey.
- `GEMINI_MODEL`: defaults to `gemini-3.8-flash`. Model availability depends on your Google AI Studio project. If unavailable, set a model ID enabled for your account.
- `NSCR_DB_PATH`: optional SQLite path. Default is `data/nscr.sqlite3` inside the project directory.

## API endpoints

- `GET /api/health`
- `POST /api/plan` — `{"task":"..."}`
- `POST /api/trace` — `{"run_id":"...","events":[...]}`
- `POST /api/verify` — `{"run_id":"...","issue":"optional"}`
- `POST /api/diagnose` — `{"run_id":"...","issue":"..."}`
- `POST /api/counterfactual` — record a user-observed controlled intervention; does not run it
- `POST /api/repair` — `{"run_id":"..."}`
- `GET /api/runs`
- `GET /api/runs/{run_id}`

## Tests

```powershell
python -m unittest discover -s tests -v
```

The test suite does not call Gemini and does not claim live API availability. The live Gemini connection must be checked on your machine after configuring your own API key.
