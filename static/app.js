
"use strict";

/*
 * NS-CR — Neuro-Symbolic Causal Recovery
 * Frontend API client
 *
 * Features:
 * - 10-minute request timeout
 * - Server-Sent Events (SSE) streaming
 * - Plan generation
 * - Trace submission
 * - Verification
 * - Diagnosis
 * - Counterfactual analysis
 * - Repair
 * - Saved runs
 *
 * API base: same origin as the FastAPI server.
 */

const REQUEST_TIMEOUT_MS = 600000;
const STREAM_TIMEOUT_MS = 600000;

const API = {
    health: "/api/health",
    plan: "/api/plan",
    streamPlan: "/api/plan/stream",
    trace: "/api/trace",
    verify: "/api/verify",
    diagnose: "/api/diagnose",
    counterfactual: "/api/counterfactual",
    repair: "/api/repair",
    runs: "/api/runs"
};

let currentRunId = null;
let currentPlan = null;
let currentTrace = [];
let activeController = null;
let isGenerating = false;

/* -------------------------------------------------------
   DOM HELPERS
------------------------------------------------------- */

function $(...ids) {
    for (const id of ids) {
        const element = document.getElementById(id);
        if (element) return element;
    }
    return null;
}

function firstExisting(...selectors) {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
    }
    return null;
}

function getValue(...ids) {
    const element = $(...ids);
    return element ? String(element.value ?? "").trim() : "";
}

function setValue(value, ...ids) {
    const element = $(...ids);
    if (element) element.value = value ?? "";
}

function setText(value, ...ids) {
    const element = $(...ids);
    if (element) element.textContent = value ?? "";
}

function setHTML(value, ...ids) {
    const element = $(...ids);
    if (element) element.innerHTML = value ?? "";
}

function show(element, visible = true) {
    if (!element) return;
    element.hidden = !visible;
    element.style.display = visible ? "" : "none";
}

function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function prettyJSON(value) {
    return JSON.stringify(value, null, 2);
}

function parseJSONInput(value, fallback = []) {
    if (!value) return fallback;

    try {
        return JSON.parse(value);
    } catch {
        throw new Error("Please enter valid JSON in the input field.");
    }
}

function setStatus(message, type = "info") {
    const element = $(
        "status",
        "statusMessage",
        "appStatus",
        "globalStatus",
        "message"
    );

    if (element) {
        element.textContent = message;
        element.dataset.type = type;
        element.className = `status status-${type}`;
        show(element);
    }

    console.log(`[NS-CR ${type.toUpperCase()}] ${message}`);
}

function showError(error) {
    const message = error instanceof Error
        ? error.message
        : String(error);

    setStatus(message, "error");

    const output = $(
        "errorOutput",
        "errorMessage",
        "apiError",
        "errorBox"
    );

    if (output) {
        output.textContent = message;
        show(output);
    }
}

function clearError() {
    const output = $(
        "errorOutput",
        "errorMessage",
        "apiError",
        "errorBox"
    );

    if (output) {
        output.textContent = "";
        show(output, false);
    }
}

function setLoading(loading, message = "Working...") {
    isGenerating = loading;

    const button = $(
        "generateBtn",
        "generatePlanBtn",
        "planBtn",
        "submitPlan",
        "runBtn"
    );

    if (button) {
        button.disabled = loading;

        if (!button.dataset.originalText) {
            button.dataset.originalText =
                button.textContent.trim() || "Generate Plan";
        }

        button.textContent = loading
            ? message
            : button.dataset.originalText;
    }

    document.body.classList.toggle("is-loading", loading);
}

function getRunId(data) {
    if (!data || typeof data !== "object") return null;

    return (
        data.run_id ??
        data.runId ??
        data.id ??
        data.run?.run_id ??
        data.run?.id ??
        null
    );
}

function updateCurrentRun(data) {
    const runId = getRunId(data);

    if (runId) {
        currentRunId = String(runId);

        setText(
            currentRunId,
            "currentRunId",
            "runId",
            "activeRunId"
        );
    }

    return currentRunId;
}

/* -------------------------------------------------------
   HTTP REQUEST HELPER
------------------------------------------------------- */

async function request(url, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        options.timeout ?? REQUEST_TIMEOUT_MS
    );

    const headers = new Headers(options.headers || {});

    if (
        options.body !== undefined &&
        !headers.has("Content-Type")
    ) {
        headers.set("Content-Type", "application/json");
    }

    headers.set("Accept", "application/json");

    try {
        const response = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal
        });

        const raw = await response.text();

        let data = null;

        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch {
                data = { detail: raw };
            }
        }

        if (!response.ok) {
            const detail =
                data?.detail ??
                data?.error ??
                data?.message ??
                `HTTP ${response.status}: ${response.statusText}`;

            throw new Error(
                typeof detail === "string"
                    ? detail
                    : prettyJSON(detail)
            );
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                `The request exceeded ${Math.round(
                    (options.timeout ?? REQUEST_TIMEOUT_MS) / 60000
                )} minutes. Check the FastAPI terminal and Gemini API response.`
            );
        }

        if (
            error instanceof TypeError &&
            !navigator.onLine
        ) {
            throw new Error(
                "Network connection lost. Check your internet connection and FastAPI server."
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function postJSON(url, body, timeout = REQUEST_TIMEOUT_MS) {
    return request(url, {
        method: "POST",
        body: JSON.stringify(body),
        timeout
    });
}

/* -------------------------------------------------------
   OUTPUT HELPERS
------------------------------------------------------- */

function renderJSON(data, ...ids) {
    const element = $(...ids);

    if (!element) {
        console.log(data);
        return;
    }

    element.textContent = prettyJSON(data);
    show(element);
}

function renderResult(data, ...ids) {
    const element = $(...ids);

    if (!element) {
        console.log(data);
        return;
    }

    if (typeof data === "string") {
        element.textContent = data;
    } else {
        element.textContent = prettyJSON(data);
    }

    show(element);
}

function renderPlan(plan) {
    currentPlan = plan;

    const output = $(
        "planOutput",
        "planResult",
        "generatedPlan",
        "planContainer"
    );

    if (!output) {
        console.log("Generated plan:", plan);
        return;
    }

    const steps = Array.isArray(plan?.steps)
        ? plan.steps
        : [];

    if (!steps.length) {
        output.textContent = prettyJSON(plan);
        show(output);
        return;
    }

    const heading = escapeHTML(
        plan.task_summary ?? "Generated recovery plan"
    );

    const assumptions = Array.isArray(plan.assumptions)
        ? plan.assumptions
        : [];

    const constraints = Array.isArray(plan.constraints)
        ? plan.constraints
        : [];

    const uncertainty = Array.isArray(plan.uncertainty_notes)
        ? plan.uncertainty_notes
        : [];

    output.innerHTML = `
        <section class="plan-result">
            <h3>${heading}</h3>

            <div class="plan-step-list">
                ${steps.map((step, index) => `
                    <article class="plan-step">
                        <h4>
                            Step ${index + 1}:
                            ${escapeHTML(step.action ?? step.id ?? "Action")}
                        </h4>

                        <p>
                            <strong>ID:</strong>
                            ${escapeHTML(step.id ?? "N/A")}
                        </p>

                        <p>
                            <strong>Rationale:</strong>
                            ${escapeHTML(step.rationale ?? "Not provided")}
                        </p>

                        <p>
                            <strong>Expected result:</strong>
                            ${escapeHTML(
                                step.expected_result ?? "Not provided"
                            )}
                        </p>

                        <p>
                            <strong>Dependencies:</strong>
                            ${escapeHTML(
                                (step.depends_on ?? []).join(", ") || "None"
                            )}
                        </p>

                        <p>
                            <strong>Risk:</strong>
                            ${escapeHTML(step.risk ?? "medium")}
                        </p>

                        <p>
                            <strong>Reversible:</strong>
                            ${step.reversible === false ? "No" : "Yes"}
                        </p>
                    </article>
                `).join("")}
            </div>

            ${assumptions.length ? `
                <h4>Assumptions</h4>
                <ul>
                    ${assumptions.map(item =>
                        `<li>${escapeHTML(item)}</li>`
                    ).join("")}
                </ul>
            ` : ""}

            ${constraints.length ? `
                <h4>Constraints</h4>
                <pre>${escapeHTML(prettyJSON(constraints))}</pre>
            ` : ""}

            ${uncertainty.length ? `
                <h4>Uncertainty notes</h4>
                <ul>
                    ${uncertainty.map(item =>
                        `<li>${escapeHTML(item)}</li>`
                    ).join("")}
                </ul>
            ` : ""}
        </section>
    `;

    show(output);

    const rawOutput = $(
        "planJSON",
        "planRawJSON",
        "rawPlanOutput"
    );

    if (rawOutput) {
        rawOutput.textContent = prettyJSON(plan);
    }

    const stepsInput = $(
        "stepsInput",
        "revisedStepsInput",
        "repairSteps"
    );

    if (stepsInput) {
        stepsInput.value = prettyJSON(steps);
    }
}

function renderRuns(runs) {
    const output = $(
        "runsOutput",
        "savedRuns",
        "runsList",
        "historyOutput"
    );

    if (!output) {
        console.log("Saved runs:", runs);
        return;
    }

    const list = Array.isArray(runs)
        ? runs
        : Array.isArray(runs?.runs)
            ? runs.runs
            : Array.isArray(runs?.items)
                ? runs.items
                : [];

    if (!list.length) {
        output.textContent = "No saved runs found.";
        show(output);
        return;
    }

    output.innerHTML = list.map(run => {
        const id = getRunId(run);
        const summary =
            run.task_summary ??
            run.task ??
            run.title ??
            "Saved run";

        return `
            <article class="saved-run">
                <h4>${escapeHTML(summary)}</h4>
                <p>Run ID: ${escapeHTML(id ?? "N/A")}</p>
                <button
                    type="button"
                    data-load-run="${escapeHTML(id ?? "")}"
                    ${id ? "" : "disabled"}
                >
                    Load run
                </button>
            </article>
        `;
    }).join("");

    show(output);
}

/* -------------------------------------------------------
   SSE STREAM PARSER
------------------------------------------------------- */

function parseSSEBlock(block) {
    const lines = block.split(/\r?\n/);

    let event = "message";
    const dataLines = [];

    for (const line of lines) {
        if (!line || line.startsWith(":")) {
            continue;
        }

        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (!dataLines.length) return null;

    const rawData = dataLines.join("\n");

    let data = rawData;

    try {
        data = JSON.parse(rawData);
    } catch {
        // Plain text SSE data is also supported.
    }

    return { event, data };
}

function extractStreamText(data) {
    if (typeof data === "string") return data;

    if (!data || typeof data !== "object") return "";

    return (
        data.text ??
        data.token ??
        data.content ??
        data.delta ??
        data.message ??
        ""
    );
}

function handleStreamEvent(parsed, callbacks) {
    if (!parsed) return;

    const { event, data } = parsed;

    if (event === "error" || data?.error) {
        const message =
            data?.error ??
            data?.detail ??
            data?.message ??
            "The streaming endpoint returned an error.";

        throw new Error(
            typeof message === "string"
                ? message
                : prettyJSON(message)
        );
    }

    if (event === "done" || event === "complete") {
        callbacks.onDone?.(data);
        return;
    }

    if (
        event === "plan" ||
        event === "result" ||
        event === "complete_plan"
    ) {
        callbacks.onPlan?.(data);
        return;
    }

    if (event === "progress" || event === "status") {
        const message =
            typeof data === "string"
                ? data
                : data?.message ?? data?.status ?? "";

        if (message) callbacks.onProgress?.(message);
        return;
    }

    const text = extractStreamText(data);

    if (text) callbacks.onText?.(text, data);

    if (data && typeof data === "object") {
        if (data.run_id || data.runId) {
            updateCurrentRun(data);
        }

        if (data.plan && typeof data.plan === "object") {
            callbacks.onPlan?.(data.plan);
        }

        if (
            Array.isArray(data.steps) &&
            (data.task_summary || data.assumptions)
        ) {
            callbacks.onPlan?.(data);
        }

        if (data.type === "error") {
            throw new Error(
                data.message ?? "The server reported a stream error."
            );
        }
    }
}

async function streamPlan(url, body, callbacks = {}) {
    if (activeController) {
        activeController.abort();
    }

    const controller = new AbortController();
    activeController = controller;

    let timeoutReached = false;

    const timeout = setTimeout(() => {
        timeoutReached = true;
        controller.abort();
    }, STREAM_TIMEOUT_MS);

    const headers = new Headers({
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json"
    });

    let reader = null;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: "no-store"
        });

        if (!response.ok) {
            const errorText = await response.text();

            let errorMessage = errorText;

            try {
                const parsed = JSON.parse(errorText);
                errorMessage =
                    parsed.detail ??
                    parsed.error ??
                    parsed.message ??
                    errorText;
            } catch {
                // Keep the original response text.
            }

            throw new Error(
                `Streaming API returned HTTP ${response.status}: ${
                    typeof errorMessage === "string"
                        ? errorMessage
                        : prettyJSON(errorMessage)
                }`
            );
        }

        if (!response.body) {
            throw new Error(
                "The server returned no response stream. Check the FastAPI endpoint."
            );
        }

        const contentType =
            response.headers.get("content-type") ?? "";

        /*
         * Some server implementations may return a normal JSON
         * response instead of SSE. Handle that case gracefully.
         */
        if (
            contentType.includes("application/json") &&
            !contentType.includes("text/event-stream")
        ) {
            const result = await response.json();

            callbacks.onPlan?.(result.plan ?? result);
            callbacks.onDone?.(result);

            return result;
        }

        reader = response.body.getReader();

        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult = null;

        while (true) {
            const { value, done } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            /*
             * SSE events are separated by a blank line.
             * Both LF and CRLF formats are supported.
             */
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";

            for (const block of blocks) {
                if (!block.trim() || block.startsWith(":")) {
                    continue;
                }

                const parsed = parseSSEBlock(block);

                if (!parsed) continue;

                handleStreamEvent(parsed, {
                    onText: (text, data) => {
                        callbacks.onText?.(text, data);
                    },

                    onProgress: message => {
                        callbacks.onProgress?.(message);
                    },

                    onPlan: plan => {
                        finalResult = plan;
                        callbacks.onPlan?.(plan);
                    },

                    onDone: data => {
                        finalResult = data ?? finalResult;
                        callbacks.onDone?.(data);
                    }
                });
            }
        }

        buffer += decoder.decode();

        if (buffer.trim()) {
            const parsed = parseSSEBlock(buffer);

            if (parsed) {
                handleStreamEvent(parsed, {
                    onText: callbacks.onText,
                    onProgress: callbacks.onProgress,

                    onPlan: plan => {
                        finalResult = plan;
                        callbacks.onPlan?.(plan);
                    },

                    onDone: data => {
                        finalResult = data ?? finalResult;
                        callbacks.onDone?.(data);
                    }
                });
            }
        }

        callbacks.onComplete?.(finalResult);

        return finalResult;
    } catch (error) {
        if (timeoutReached) {
            throw new Error(
                "Streaming timed out after 10 minutes. Check the FastAPI terminal, Gemini API key, model name, quota, and network connection."
            );
        }

        if (error.name === "AbortError") {
            throw new Error(
                "The streaming request was cancelled."
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);

        if (reader) {
            try {
                await reader.cancel();
            } catch {
                // The stream may already be closed.
            }
        }

        if (activeController === controller) {
            activeController = null;
        }
    }
}

/* -------------------------------------------------------
   PLAN GENERATION
------------------------------------------------------- */

function getTaskDescription() {
    return getValue(
        "taskInput",
        "task",
        "taskDescription",
        "taskDescriptionInput",
        "problemInput",
        "goalInput"
    );
}

function getPlanRequestBody() {
    const task = getTaskDescription();

    if (!task) {
        throw new Error(
            "Enter a task or problem description before generating a plan."
        );
    }

    const body = { task };

    const context = getValue(
        "contextInput",
        "context",
        "systemContext"
    );

    const constraints = getValue(
        "constraintsInput",
        "constraintsText"
    );

    const observations = getValue(
        "observationsInput",
        "observations"
    );

    if (context) body.context = context;

    if (constraints) {
        body.constraints = constraints;
    }

    if (observations) {
        body.observations = observations;
    }

    return body;
}

function showStreamText(text) {
    const output = $(
        "streamOutput",
        "streamText",
        "generationProgress",
        "streamingOutput"
    );

    if (!output) return;

    output.textContent += text;
    show(output);
}

async function generatePlan() {
    if (isGenerating) return;

    clearError();
    setLoading(true, "Generating plan...");

    const streamOutput = $(
        "streamOutput",
        "streamText",
        "generationProgress",
        "streamingOutput"
    );

    if (streamOutput) {
        streamOutput.textContent = "";
        show(streamOutput);
    }

    try {
        const body = getPlanRequestBody();

        setStatus(
            "Connecting to NS-CR streaming endpoint...",
            "info"
        );

        let receivedPlan = null;

        const result = await streamPlan(
            API.streamPlan,
            body,
            {
                onProgress(message) {
                    setStatus(message, "info");
                },

                onText(text) {
                    showStreamText(text);
                },

                onPlan(plan) {
                    if (!plan || typeof plan !== "object") {
                        return;
                    }

                    receivedPlan = plan.plan ?? plan;

                    if (Array.isArray(receivedPlan.steps)) {
                        renderPlan(receivedPlan);
                    }

                    updateCurrentRun(plan);
                },

                onDone(data) {
                    if (data && typeof data === "object") {
                        updateCurrentRun(data);

                        if (data.plan) {
                            receivedPlan = data.plan;
                        } else if (Array.isArray(data.steps)) {
                            receivedPlan = data;
                        }
                    }
                }
            }
        );

        if (!receivedPlan && result && typeof result === "object") {
            receivedPlan = result.plan ?? result;
        }

        if (
            receivedPlan &&
            Array.isArray(receivedPlan.steps)
        ) {
            renderPlan(receivedPlan);
            setStatus("Plan generated successfully.", "success");
        } else {
            setStatus(
                "The stream finished, but no complete plan object was received. Check the stream output and FastAPI response format.",
                "warning"
            );

            if (result) {
                renderResult(
                    result,
                    "planOutput",
                    "planResult",
                    "generatedPlan"
                );
            }
        }

        await loadRunsSilently();
    } catch (error) {
        showError(error);
    } finally {
        setLoading(false);
    }
}

/* -------------------------------------------------------
   TRACE SUBMISSION
------------------------------------------------------- */

function getTraceRequestBody() {
    const runId =
        getValue("traceRunId", "traceRunIdInput") ||
        currentRunId;

    if (!runId) {
        throw new Error(
            "Generate or select a run before submitting trace events."
        );
    }

    const rawEvents = getValue(
        "traceInput",
        "traceJSON",
        "eventsInput",
        "traceEvents"
    );

    let events = [];

    if (rawEvents) {
        events = parseJSONInput(rawEvents);
    } else {
        const eventId = getValue(
            "eventIdInput",
            "eventId"
        );

        const stepId = getValue(
            "traceStepId",
            "stepIdInput"
        );

        const status = getValue(
            "traceStatus",
            "eventStatus"
        ) || "unknown";

        const source = getValue(
            "traceSource",
            "eventSource"
        ) || "manual";

        const inputObservation = getValue(
            "inputObservation",
            "traceInputObservation"
        );

        const outputObservation = getValue(
            "outputObservation",
            "traceOutputObservation"
        );

        if (!eventId) {
            throw new Error(
                "Enter an event ID or provide trace events as JSON."
            );
        }

        const event = {
            event_id: eventId,
            status,
            source
        };

        if (stepId) event.step_id = stepId;

        if (inputObservation) {
            event.input_observation = inputObservation;
        }

        if (outputObservation) {
            event.output_observation = outputObservation;
        }

        events = [event];
    }

    return {
        run_id: runId,
        events
    };
}

async function submitTrace() {
    clearError();

    try {
        const body = getTraceRequestBody();

        const result = await postJSON(API.trace, body);

        currentTrace = body.events;

        renderResult(
            result,
            "traceOutput",
            "traceResult",
            "traceResponse"
        );

        setStatus("Trace submitted successfully.", "success");
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   VERIFICATION
------------------------------------------------------- */

async function verifyRun() {
    clearError();

    try {
        const runId =
            getValue("verifyRunId", "verificationRunId") ||
            currentRunId;

        if (!runId) {
            throw new Error(
                "Enter a run ID or generate a plan first."
            );
        }

        const result = await postJSON(API.verify, {
            run_id: runId
        });

        renderResult(
            result,
            "verifyOutput",
            "verificationOutput",
            "verificationResult"
        );

        setStatus("Verification completed.", "success");
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   DIAGNOSIS
------------------------------------------------------- */

async function diagnoseRun() {
    clearError();

    try {
        const runId =
            getValue("diagnoseRunId", "diagnosisRunId") ||
            currentRunId;

        if (!runId) {
            throw new Error(
                "Enter a run ID or generate a plan first."
            );
        }

        const body = { run_id: runId };

        const question = getValue(
            "diagnosisQuestion",
            "diagnoseQuestion",
            "diagnosisInput"
        );

        const context = getValue(
            "diagnosisContext",
            "diagnoseContext"
        );

        if (question) body.question = question;
        if (context) body.context = context;

        const result = await postJSON(API.diagnose, body);

        renderResult(
            result,
            "diagnosisOutput",
            "diagnoseOutput",
            "diagnosisResult"
        );

        setStatus("Diagnosis completed.", "success");
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   COUNTERFACTUAL ANALYSIS
------------------------------------------------------- */

function getCounterfactualBody() {
    const runId =
        getValue("counterfactualRunId", "cfRunId") ||
        currentRunId;

    if (!runId) {
        throw new Error(
            "Enter a run ID or generate a plan first."
        );
    }

    const candidateStepId = getValue(
        "candidateStepId",
        "counterfactualStepId",
        "cfStepId"
    );

    const interventionDescription = getValue(
        "interventionDescription",
        "interventionInput"
    );

    const baselineOutcome = getValue(
        "baselineOutcome",
        "baselineInput"
    );

    const interventionOutcome = getValue(
        "interventionOutcome",
        "interventionOutcomeInput"
    );

    const evidenceSource = getValue(
        "evidenceSource",
        "counterfactualEvidenceSource"
    ) || "user-provided";

    if (!candidateStepId) {
        throw new Error("Enter the candidate step ID.");
    }

    if (!interventionDescription) {
        throw new Error("Describe the intervention.");
    }

    if (!baselineOutcome || !interventionOutcome) {
        throw new Error(
            "Enter both the baseline outcome and intervention outcome."
        );
    }

    const conditionsText = getValue(
        "conditionsHeldConstant",
        "heldConstantInput"
    );

    const conditionsHeldConstant = conditionsText
        ? conditionsText
            .split(/\r?\n|,/)
            .map(value => value.trim())
            .filter(Boolean)
        : [];

    const executedElement = $(
        "interventionWasExecuted",
        "interventionExecuted"
    );

    return {
        run_id: runId,
        candidate_step_id: candidateStepId,
        intervention_description: interventionDescription,
        baseline_outcome: baselineOutcome,
        intervention_outcome: interventionOutcome,
        conditions_held_constant: conditionsHeldConstant,
        evidence_source: evidenceSource,
        intervention_was_executed:
            executedElement?.checked ?? false
    };
}

async function runCounterfactual() {
    clearError();

    try {
        const body = getCounterfactualBody();

        const result = await postJSON(
            API.counterfactual,
            body
        );

        renderResult(
            result,
            "counterfactualOutput",
            "counterfactualResult",
            "cfOutput"
        );

        setStatus(
            "Counterfactual analysis completed.",
            "success"
        );
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   REPAIR
------------------------------------------------------- */

async function repairRun() {
    clearError();

    try {
        const runId =
            getValue("repairRunId", "repairRunIdInput") ||
            currentRunId;

        if (!runId) {
            throw new Error(
                "Enter a run ID or generate a plan first."
            );
        }

        const body = { run_id: runId };

        const diagnosis = getValue(
            "repairDiagnosis",
            "repairDiagnosisInput",
            "rootCauseInput"
        );

        const instructions = getValue(
            "repairInstructions",
            "repairInstructionInput"
        );

        const revisedStepsText = getValue(
            "revisedStepsInput",
            "repairSteps"
        );

        if (diagnosis) {
            body.diagnosis = diagnosis;
        }

        if (instructions) {
            body.instructions = instructions;
        }

        if (revisedStepsText) {
            body.revised_steps = parseJSONInput(
                revisedStepsText,
                []
            );
        }

        const result = await postJSON(API.repair, body);

        renderResult(
            result,
            "repairOutput",
            "repairResult",
            "repairResponse"
        );

        setStatus(
            "Repair analysis completed. Review the proposed changes before applying them.",
            "success"
        );

        await loadRunsSilently();
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   SAVED RUNS
------------------------------------------------------- */

async function loadRuns() {
    clearError();

    try {
        const result = await request(API.runs);

        renderRuns(result);

        setStatus("Saved runs loaded.", "success");

        return result;
    } catch (error) {
        showError(error);
        return null;
    }
}

async function loadRunsSilently() {
    try {
        const result = await request(API.runs);
        renderRuns(result);
        return result;
    } catch (error) {
        console.warn("Could not refresh saved runs:", error.message);
        return null;
    }
}

async function loadRun(runId) {
    clearError();

    if (!runId) {
        showError(new Error("No run ID was provided."));
        return;
    }

    try {
        const result = await request(
            `${API.runs}/${encodeURIComponent(runId)}`
        );

        currentRunId = String(runId);
        updateCurrentRun(result);

        renderResult(
            result,
            "runDetailOutput",
            "runDetails",
            "selectedRunOutput"
        );

        const plan = result.plan ?? result;

        if (Array.isArray(plan.steps)) {
            renderPlan(plan);
        }

        const trace = result.trace ?? result.events;

        if (Array.isArray(trace)) {
            currentTrace = trace;

            const traceInput = $(
                "traceInput",
                "traceJSON",
                "eventsInput",
                "traceEvents"
            );

            if (traceInput) {
                traceInput.value = prettyJSON(trace);
            }
        }

        setStatus(`Loaded run ${runId}.`, "success");
    } catch (error) {
        showError(error);
    }
}

/* -------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------- */

async function checkHealth() {
    try {
        const result = await request(API.health, {
            timeout: 15000
        });

        renderResult(
            result,
            "healthOutput",
            "healthStatus",
            "apiHealth"
        );

        setStatus("FastAPI server is reachable.", "success");

        return result;
    } catch (error) {
        setStatus(
            `FastAPI health check failed: ${error.message}`,
            "error"
        );

        return null;
    }
}

/* -------------------------------------------------------
   EVENT BINDING
------------------------------------------------------- */

function bindClick(ids, callback) {
    const element = $(...ids);

    if (!element) return;

    element.addEventListener("click", event => {
        event.preventDefault();

        Promise.resolve(callback()).catch(showError);
    });
}

function bindForm(ids, callback) {
    const form = $(...ids);

    if (!form) return;

    form.addEventListener("submit", event => {
        event.preventDefault();

        Promise.resolve(callback()).catch(showError);
    });
}

function bindEvents() {
    bindClick(
        [
            "generateBtn",
            "generatePlanBtn",
            "planBtn",
            "submitPlan",
            "runBtn"
        ],
        generatePlan
    );

    bindForm(
        ["planForm", "generatePlanForm", "taskForm"],
        generatePlan
    );

    bindClick(
        ["submitTraceBtn", "traceBtn", "sendTraceBtn"],
        submitTrace
    );

    bindForm(
        ["traceForm", "submitTraceForm"],
        submitTrace
    );

    bindClick(
        ["verifyBtn", "verifyRunBtn", "verificationBtn"],
        verifyRun
    );

    bindForm(
        ["verifyForm", "verificationForm"],
        verifyRun
    );

    bindClick(
        ["diagnoseBtn", "diagnoseRunBtn", "diagnosisBtn"],
        diagnoseRun
    );

    bindForm(
        ["diagnoseForm", "diagnosisForm"],
        diagnoseRun
    );

    bindClick(
        [
            "counterfactualBtn",
            "runCounterfactualBtn",
            "cfBtn"
        ],
        runCounterfactual
    );

    bindForm(
        ["counterfactualForm", "cfForm"],
        runCounterfactual
    );

    bindClick(
        ["repairBtn", "repairRunBtn", "runRepairBtn"],
        repairRun
    );

    bindForm(
        ["repairForm", "repairRunForm"],
        repairRun
    );

    bindClick(
        ["refreshRunsBtn", "loadRunsBtn", "runsBtn"],
        loadRuns
    );

    bindClick(
        ["healthBtn", "checkHealthBtn"],
        checkHealth
    );

    document.addEventListener("click", event => {
        const button = event.target.closest("[data-load-run]");

        if (!button) return;

        const runId = button.getAttribute("data-load-run");

        if (runId) {
            loadRun(runId);
        }
    });

    /*
     * Stop an ongoing stream when the user clicks a cancel button.
     */
    bindClick(
        ["cancelGenerationBtn", "cancelStreamBtn"],
        () => {
            if (activeController) {
                activeController.abort();
                setStatus("Generation cancelled.", "warning");
            }
        }
    );

    /*
     * Optional: copy raw plan JSON to the clipboard.
     */
    bindClick(
        ["copyPlanBtn", "copyPlanJSONBtn"],
        async () => {
            if (!currentPlan) {
                throw new Error("There is no generated plan to copy.");
            }

            await navigator.clipboard.writeText(
                prettyJSON(currentPlan)
            );

            setStatus("Plan JSON copied to clipboard.", "success");
        }
    );
}

/* -------------------------------------------------------
   APPLICATION STARTUP
------------------------------------------------------- */

async function initializeApp() {
    bindEvents();

    console.info("NS-CR frontend initialized.");
    console.info("Request timeout:", REQUEST_TIMEOUT_MS, "ms");
    console.info("Streaming timeout:", STREAM_TIMEOUT_MS, "ms");

    /*
     * Populate the run list and health indicator without
     * blocking the page from loading.
     */
    await Promise.allSettled([
        checkHealth(),
        loadRunsSilently()
    ]);
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeApp,
        { once: true }
    );
} else {
    initializeApp();
}

/* -------------------------------------------------------
   OPTIONAL GLOBAL ACCESS FOR DEBUGGING
------------------------------------------------------- */

window.NSCR = {
    request,
    streamPlan,
    generatePlan,
    submitTrace,
    verifyRun,
    diagnoseRun,
    runCounterfactual,
    repairRun,
    loadRuns,
    loadRun,
    checkHealth,

    getState() {
        return {
            currentRunId,
            currentPlan,
            currentTrace,
            isGenerating
        };
    }
};