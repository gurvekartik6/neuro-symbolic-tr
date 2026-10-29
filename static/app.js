
"use strict";

const API = {
  health: "/api/health",
  plan: "/api/plan",
  streamPlan: "/api/plan/stream",
  trace: "/api/trace",
  tools: "/api/tools",
  execute: "/api/execute",
  verify: "/api/verify",
  diagnose: "/api/diagnose",
  repair: "/api/repair",
  counterfactual: "/api/counterfactual",
  causalAnalysis: "/api/causal-analysis",
  retest: "/api/retest",
  runs: "/api/runs"
};

const REQUEST_TIMEOUT_MS = 600000;
const STREAM_TIMEOUT_MS = 600000;

let currentRunId = null;
let currentPlan = null;
let currentRepair = null;
let configuredTools = [];
let activeController = null;
let busy = false;

const $ = id => document.getElementById(id);
const pretty = value => JSON.stringify(value, null, 2);

function showElement(id, show = true) {
  const element = $(id);
  if (element) element.classList.toggle("hidden", !show);
}

function status(message, type = "info") {
  const alert = $("alert");

  if (alert) {
    alert.textContent = message;
    alert.classList.remove("hidden");
    alert.dataset.type = type;
    alert.setAttribute("role", type === "error" ? "alert" : "status");
  }

  console[type === "error" ? "error" : "log"](
    `[NS-CR ${type.toUpperCase()}] ${message}`
  );
}

function showError(error) {
  status(error?.message || String(error), "error");
}

function updateRun(runId) {
  if (!runId) return;

  currentRunId = String(runId);

  const meta = $("runMeta");
  if (meta) meta.textContent = `Run ID: ${currentRunId}`;
}

function renderJSON(id, data) {
  const target = $(id);
  if (!target) return;

  const pre = document.createElement("pre");
  pre.textContent = pretty(data);

  target.replaceChildren(pre);
  target.classList.remove("hidden");
}

async function request(url, options = {}) {
  const timeoutMs = options.timeout ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(options.headers || {});

  headers.set("Accept", "application/json");

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const fetchOptions = { ...options };
  delete fetchOptions.timeout;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
      cache: "no-store"
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
        data?.message ??
        data?.error ??
        `HTTP ${response.status}: ${response.statusText}`;

      throw new Error(
        typeof detail === "string" ? detail : pretty(detail)
      );
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 60000)} minutes.`
      );
    }

    if (error instanceof TypeError) {
      throw new Error(
        `Could not connect to ${url}. Check that FastAPI is running.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function postJSON(url, payload) {
  return request(url, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/* =========================================================
   Plan rendering
   ========================================================= */

function renderPlan(plan, runId, model) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("The server did not return a valid plan.");
  }

  currentPlan = plan;

  if (runId) updateRun(runId);

  const meta = $("runMeta");
  if (meta && model) {
    meta.textContent =
      `Run ID: ${currentRunId || "not saved"} · Model: ${model}`;
  }

  const target = $("planView");
  if (!target) return;

  const container = document.createElement("div");
  container.className = "result";

  const heading = document.createElement("h3");
  heading.textContent = plan.task_summary || "Generated plan";
  container.appendChild(heading);

  plan.steps.forEach((step, index) => {
    const article = document.createElement("article");
    article.className = "step";

    const title = document.createElement("h3");
    title.textContent = `${index + 1}. ${step.action || step.id}`;
    article.appendChild(title);

    const fields = [
      ["Step ID", step.id],
      ["Rationale", step.rationale],
      ["Expected result", step.expected_result],
      ["Risk", step.risk || "medium"],
      ["Dependencies", (step.depends_on || []).join(", ") || "None"],
      ["Reversible", step.reversible === false ? "No" : "Yes"]
    ];

    fields.forEach(([label, value]) => {
      const p = document.createElement("p");
      const strong = document.createElement("strong");

      strong.textContent = `${label}: `;
      p.append(
        strong,
        document.createTextNode(String(value ?? "Not provided"))
      );

      article.appendChild(p);
    });

    container.appendChild(article);
  });

  function addList(title, items) {
    if (!Array.isArray(items) || items.length === 0) return;

    const heading = document.createElement("h3");
    heading.textContent = title;
    container.appendChild(heading);

    const list = document.createElement("ul");

    items.forEach(item => {
      const li = document.createElement("li");
      li.textContent =
        typeof item === "string" ? item : pretty(item);
      list.appendChild(li);
    });

    container.appendChild(list);
  }

  addList("Assumptions", plan.assumptions);
  addList("Constraints", plan.constraints);
  addList("Uncertainty notes", plan.uncertainty_notes);

  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent =
    "This is a proposed plan. No real-world actions were executed.";

  container.appendChild(notice);
  target.replaceChildren(container);

  showElement("planPanel", true);
  renderExecutionBindings(configuredTools);
}

/* =========================================================
   Streaming plan generation
   ========================================================= */

function parseSSEBlock(block) {
  let eventName = "message";
  const dataLines = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;

  try {
    return {
      eventName,
      data: JSON.parse(dataLines.join("\n"))
    };
  } catch {
    return {
      eventName,
      data: { message: dataLines.join("\n") }
    };
  }
}

async function streamPlan(payload) {
  if (activeController) activeController.abort();

  const controller = new AbortController();
  activeController = controller;

  let reader = null;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, STREAM_TIMEOUT_MS);

  try {
    const response = await fetch(API.streamPlan, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      const raw = await response.text();
      let message = raw;

      try {
        const parsed = JSON.parse(raw);
        message = parsed.detail || parsed.message || raw;
      } catch {}

      throw new Error(
        `Streaming endpoint returned HTTP ${response.status}: ${message}`
      );
    }

    if (!response.body) {
      throw new Error("The server returned no response stream.");
    }

    reader = response.body.getReader();

    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    const processBlock = block => {
      const parsed = parseSSEBlock(block);
      if (!parsed) return;

      const event = parsed.data;

      if (parsed.eventName === "error" || event.type === "error") {
        throw new Error(event.message || "The streaming request failed.");
      }

      if (event.type === "status") {
        status(event.message || "Gemini is working…");
      }

      if (event.type === "delta") {
        status("Gemini is generating your plan…");
      }

      if (event.type === "complete") {
        if (!event.plan) {
          throw new Error("The server completed without returning a plan.");
        }

        renderPlan(event.plan, event.run_id, event.model);
        completed = true;
        status("Plan generated and saved successfully.", "success");
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      blocks.forEach(processBlock);
    }

    buffer += decoder.decode();

    if (buffer.trim()) processBlock(buffer);

    if (!completed) {
      throw new Error(
        "The stream ended before a complete plan was received."
      );
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(
        "Streaming timed out after 10 minutes. Check FastAPI and Gemini settings."
      );
    }

    if (error.name === "AbortError") {
      throw new Error("The streaming request was cancelled.");
    }

    throw error;
  } finally {
    clearTimeout(timer);

    if (reader) {
      try {
        await reader.cancel();
      } catch {}
    }

    if (activeController === controller) {
      activeController = null;
    }
  }
}

async function generatePlan() {
  if (busy) return;

  const task = $("task")?.value.trim() || "";

  if (task.length < 10) {
    status(
      "Enter a task description containing at least 10 characters.",
      "error"
    );
    return;
  }

  busy = true;
  currentRepair = null;

  [
    "diagnosisView",
    "repairView",
    "verificationView",
    "retestView",
    "counterfactualView",
    "executionTraceView"
  ].forEach(id => {
    if ($(id)) $(id).replaceChildren();
  });

  showElement("additionalInterventionEvidence", false);

  const button = $("planBtn");

  if (button) {
    button.disabled = true;
    button.textContent = "Generating…";
  }

  try {
    status("Connecting to Gemini…");
    await streamPlan({ task });
    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;

    if (button) {
      button.disabled = false;
      button.textContent = "Generate plan with Gemini";
    }
  }
}

/* =========================================================
   Trace templates and manual trace import
   ========================================================= */

function generateTraceTemplate() {
  if (!currentPlan?.steps?.length) {
    status("Generate or load a plan before creating a trace template.", "error");
    return;
  }

  const events = currentPlan.steps.map((step, index) => ({
    event_id: `event_${index + 1}`,
    step_id: step.id,
    status: "unknown",
    source: "generated_template_pending_observation",
    input_observation: null,
    output_observation: null,
    preconditions_met: null,
    postconditions_met: null
  }));

  if ($("traceJson")) {
    $("traceJson").value = pretty(events);
  }

  if ($("traceTemplateMessage")) {
    $("traceTemplateMessage").textContent =
      "Template created. Replace placeholders only with real observations and evidence sources.";
  }

  status("Trace template generated. No execution is implied.", "success");
}

async function copyTraceTemplate() {
  const text = $("traceJson")?.value || "";

  if (!text) {
    status("Generate a trace template before copying it.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    status("Trace JSON copied.", "success");
  } catch {
    status("Copy failed. Select and copy the trace JSON manually.", "error");
  }
}

async function submitTrace() {
  if (!currentRunId) {
    status("Generate or load a saved run before submitting trace events.", "error");
    return;
  }

  let events;

  try {
    events = JSON.parse($("traceJson")?.value || "");
  } catch {
    status("Trace events must be a valid JSON array.", "error");
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    status("Enter a non-empty array of trace events.", "error");
    return;
  }

  try {
    const result = await postJSON(API.trace, {
      run_id: currentRunId,
      events
    });

    updateRun(result.run_id);
    renderJSON("verificationView", result.verification);

    status(
      `Saved ${result.trace_event_count ?? events.length} trace event(s).`,
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   API tool discovery and per-step bindings
   ========================================================= */

function renderExecutionBindings(tools) {
  const container = $("executionBindings");
  if (!container) return;

  // Older HTML uses a JSON textarea. Preserve that interface.
  if (
    container instanceof HTMLTextAreaElement ||
    container instanceof HTMLInputElement
  ) {
    return;
  }

  // Preserve selections when refreshing the configured tools list.
  const previousValues = new Map();

  container.querySelectorAll("select[data-step-id]").forEach(select => {
    const stepId = select.dataset.stepId;
    const params = Array.from(
      container.querySelectorAll("textarea[data-params-step]")
    ).find(item => item.dataset.paramsStep === stepId);

    previousValues.set(stepId, {
      tool: select.value,
      parameters: params?.value || "{}"
    });
  });

  container.replaceChildren();

  if (!currentPlan?.steps?.length) {
    const note = document.createElement("p");
    note.className = "trace-help";
    note.textContent =
      "Generate or load a plan to bind its steps to configured API tools.";
    container.appendChild(note);
    return;
  }

  if (!tools.length) {
    const note = document.createElement("p");
    note.className = "trace-help";
    note.textContent =
      "No API tools are configured. Add NSCR_HTTP_TOOLS_JSON to the server .env file and restart FastAPI.";
    container.appendChild(note);
    return;
  }

  currentPlan.steps.forEach((step, index) => {
    const card = document.createElement("section");
    card.className = "execution-binding";

    const heading = document.createElement("h3");
    heading.textContent = `${index + 1}. ${step.action || step.id} (${step.id})`;
    card.appendChild(heading);

    const description = document.createElement("p");
    description.textContent =
      step.rationale ||
      step.expected_result ||
      "Choose a configured API tool only if it performs this step.";
    card.appendChild(description);

    const toolLabel = document.createElement("label");
    toolLabel.textContent = "Configured API tool";
    card.appendChild(toolLabel);

    const select = document.createElement("select");
    select.dataset.stepId = step.id;
    select.setAttribute("aria-label", `API tool for ${step.id}`);

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Do not execute this step";
    select.appendChild(none);

    tools.forEach(tool => {
      const option = document.createElement("option");
      option.value = tool.name;

      option.textContent =
        `${tool.name} · ${tool.method} · ${tool.host}` +
        (tool.requires_external_confirmation
          ? " · confirmation required"
          : "");

      select.appendChild(option);
    });

    const previous = previousValues.get(step.id);

    if (previous?.tool && tools.some(tool => tool.name === previous.tool)) {
      select.value = previous.tool;
    }

    card.appendChild(select);

    const paramsLabel = document.createElement("label");
    paramsLabel.textContent = "Parameters (JSON object)";
    card.appendChild(paramsLabel);

    const params = document.createElement("textarea");
    params.rows = 3;
    params.spellcheck = false;
    params.dataset.paramsStep = step.id;
    params.setAttribute("aria-label", `JSON parameters for ${step.id}`);
    params.placeholder = '{"item_id":"123"}';
    params.value = previous?.parameters || "{}";
    card.appendChild(params);

    const help = document.createElement("p");
    help.className = "trace-help";
    help.textContent =
      "Only fields configured for this server-side tool are used. Leave the tool unselected to skip this step.";
    card.appendChild(help);

    container.appendChild(card);
  });
}

async function loadConfiguredTools(showMessage = false) {
  const statusElement =
    $("executionToolStatus") || $("toolsStatus");
  const listElement = $("toolsList");

  try {
    // Actual route in nscr/main.py: GET /api/tools
    const result = await request(API.tools, { timeout: 15000 });

    configuredTools = Array.isArray(result?.tools) ? result.tools : [];

    if (statusElement) {
      statusElement.textContent = configuredTools.length
        ? `${configuredTools.length} allowlisted API tool(s) configured.`
        : "No API tools configured. Add NSCR_HTTP_TOOLS_JSON to .env and restart the server.";

      statusElement.dataset.type =
        configuredTools.length ? "success" : "warning";
    }

    if (listElement) {
      if (!configuredTools.length) {
        listElement.textContent = "No configured tools are available yet.";
      } else {
        const pre = document.createElement("pre");
        pre.textContent = pretty(configuredTools);
        listElement.replaceChildren(pre);
      }
    }

    renderExecutionBindings(configuredTools);

    if (showMessage) {
      status("Configured API tools refreshed.", "success");
    }
  } catch (error) {
    if (statusElement) {
      statusElement.textContent =
        `Could not load API tools: ${error.message}`;
    }

    if (showMessage) showError(error);
  }
}

function readExecutionBindings() {
  const element = $("executionBindings");

  if (!element) {
    throw new Error("The execution bindings control was not found in the page.");
  }

  // Legacy interface: user supplies the complete JSON array.
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    let bindings;

    try {
      bindings = JSON.parse(element.value.trim() || "[]");
    } catch {
      throw new Error("Step-to-tool bindings must be valid JSON.");
    }

    if (!Array.isArray(bindings)) {
      throw new Error("Step-to-tool bindings must be a JSON array.");
    }

    return bindings;
  }

  // Updated interface: each step has a tool selector and parameters field.
  const bindings = [];

  element.querySelectorAll("select[data-step-id]").forEach(select => {
    const toolName = select.value;
    if (!toolName) return;

    const stepId = select.dataset.stepId;

    const paramsElement = Array.from(
      element.querySelectorAll("textarea[data-params-step]")
    ).find(item => item.dataset.paramsStep === stepId);

    let parameters;

    try {
      parameters = JSON.parse(paramsElement?.value.trim() || "{}");
    } catch {
      throw new Error(
        `Parameters for ${stepId} must be a valid JSON object.`
      );
    }

    if (
      parameters === null ||
      Array.isArray(parameters) ||
      typeof parameters !== "object"
    ) {
      throw new Error(`Parameters for ${stepId} must be a JSON object.`);
    }

    bindings.push({
      step_id: stepId,
      tool_name: toolName,
      parameters
    });
  });

  return bindings;
}

async function executeConfiguredPlan() {
  if (busy) return;

  if (!currentRunId || !currentPlan) {
    status("Generate or load a saved plan before executing API tools.", "error");
    return;
  }

  let bindings;

  try {
    bindings = readExecutionBindings();
  } catch (error) {
    status(error.message, "error");
    return;
  }

  if (bindings.length > 20) {
    status("A maximum of 20 API tool bindings can be submitted at once.", "error");
    return;
  }

  const button = $("executeApisBtn") || $("executePlanBtn");
  const confirmed = Boolean($("confirmExternalActions")?.checked);

  busy = true;

  if (button) {
    button.disabled = true;
    button.textContent = "Executing APIs…";
  }

  if ($("executionMessage")) {
    $("executionMessage").textContent =
      "Calling configured APIs and capturing responses…";
  }

  try {
    // Backend expects bindings and returns trace, not trace_events.
    const result = await postJSON(API.execute, {
      run_id: currentRunId,
      bindings,
      confirm_external_actions: confirmed
    });

    updateRun(result.run_id);

    const trace = Array.isArray(result.trace) ? result.trace : [];

    if ($("traceJson")) {
      $("traceJson").value = pretty(trace);
    }

    renderJSON("executionTraceView", {
      executed_api_calls: result.executed_api_calls ?? 0,
      trace_event_count: result.trace_event_count ?? trace.length,
      trace,
      notice: result.notice
    });

    renderJSON("verificationView", result.verification);

    if ($("executionMessage")) {
      $("executionMessage").textContent =
        `Execution finished: ${result.executed_api_calls ?? 0} API call(s), ` +
        `${result.trace_event_count ?? trace.length} trace event(s). ` +
        "Review successes, failures, and skipped steps below.";
    }

    status("API execution finished and trace saved automatically.", "success");

    await loadRuns(false);
  } catch (error) {
    if ($("executionMessage")) {
      $("executionMessage").textContent = error.message || String(error);
    }

    showError(error);
  } finally {
    busy = false;

    if (button) {
      button.disabled = false;
      button.textContent = "Execute configured APIs and capture trace";
    }
  }
}

/* =========================================================
   Verification, diagnosis and repair
   ========================================================= */

async function verifyRun() {
  if (!currentRunId) {
    status("Generate or load a saved run first.", "error");
    return;
  }

  try {
    const result = await postJSON(API.verify, {
      run_id: currentRunId,
      issue: $("issue")?.value.trim() || ""
    });

    updateRun(result.run_id);
    renderJSON("verificationView", result.verification);

    status("Verification completed.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

async function diagnose() {
  if (!currentRunId) {
    status("Generate or load a saved plan first.", "error");
    return;
  }

  try {
    const result = await postJSON(API.diagnose, {
      run_id: currentRunId,
      issue: $("issue")?.value.trim() || ""
    });

    updateRun(result.run_id);
    renderJSON("diagnosisView", result.diagnosis);

    if (result.verification) {
      renderJSON("verificationView", result.verification);
    }

    showElement("repairArea", true);

    status(
      result.diagnosis?.causal_status === "undetermined"
        ? "Diagnosis is undetermined. Review the available evidence."
        : "Diagnosis hypothesis generated. It is not proof of causality.",
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

async function repair() {
  if (!currentRunId) {
    status("Generate or load a diagnosed run before requesting a repair.", "error");
    return;
  }

  try {
    const result = await postJSON(API.repair, {
      run_id: currentRunId
    });

    updateRun(result.run_id);
    currentRepair = result.repair;

    renderJSON("repairView", result.repair);

    status("Repair proposal generated. It has not been executed.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   Retest workflow
   ========================================================= */

function generateRetestTemplate() {
  if (!currentRepair?.revised_steps?.length) {
    status(
      "Load a saved repair proposal or generate one before creating a retest template.",
      "error"
    );
    return;
  }

  const events = currentRepair.revised_steps.map((step, index) => ({
    event_id: `retest_event_${index + 1}`,
    step_id: step.id,
    status: "unknown",
    source: "generated_template_pending_observation",
    input_observation: null,
    output_observation: null,
    preconditions_met: null,
    postconditions_met: null
  }));

  if ($("retestTraceJson")) {
    $("retestTraceJson").value = pretty(events);
  }

  status(
    "Retest template generated with unknown outcomes. Replace placeholders with actual observations before submitting.",
    "success"
  );
}

async function submitRetest() {
  if (!currentRunId || !currentRepair?.revised_steps?.length) {
    status(
      "Generate or load a saved repair proposal before retesting.",
      "error"
    );
    return;
  }

  let events;

  try {
    events = JSON.parse($("retestTraceJson")?.value || "");
  } catch {
    status("Retest trace must be a valid JSON array.", "error");
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    status("Enter actual retest events before continuing.", "error");
    return;
  }

  const revisedIds = new Set(
    currentRepair.revised_steps.map(step => step.id)
  );

  const revisedPlan = {
    ...currentPlan,
    steps: currentRepair.revised_steps,
    constraints: (currentPlan?.constraints || []).map(constraint => ({
      ...constraint,
      relevant_step_ids: (constraint.relevant_step_ids || [])
        .filter(id => revisedIds.has(id))
    }))
  };

  try {
    const result = await postJSON(API.retest, {
      source_run_id: currentRunId,
      revised_plan: revisedPlan,
      events,
      original_issue:
        $("issue")?.value.trim() || "Retest of the proposed repair"
    });

    updateRun(result.run_id);
    renderJSON("retestView", result.retest);

    const retestStatus = result.retest?.status || "inconclusive";

    status(
      `Retest saved. Status: ${retestStatus}.`,
      retestStatus === "retest_failed" ? "error" : "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   Causal analysis and intervention evidence
   ========================================================= */

async function runCausalAnalysis() {
  if (!currentRunId || !currentPlan) {
    status(
      "Generate or load a saved workflow before running causal analysis.",
      "error"
    );
    return;
  }

  const button = $("causalAnalysisBtn");

  if (button) {
    button.disabled = true;
    button.textContent = "Analyzing saved evidence…";
  }

  try {
    const result = await postJSON(API.causalAnalysis, {
      run_id: currentRunId
    });

    updateRun(result.run_id);
    renderJSON("counterfactualView", result);

    const missing = Array.isArray(result.missing_evidence)
      ? result.missing_evidence
      : [];

    const interventionItems = new Set([
      "intervention_evidence",
      "executed_intervention_evidence",
      "candidate_step_id",
      "intervention_description",
      "baseline_outcome",
      "intervention_outcome",
      "evidence_source",
      "controlled_conditions"
    ]);

    const needsEvidence = missing.some(item =>
      interventionItems.has(item.item)
    );

    showElement("additionalInterventionEvidence", needsEvidence);

    status(
      `Automatic analysis completed. Status: ${result.status || "undetermined"}. ` +
      `${missing.length} evidence gap(s) identified.`,
      result.status === "intervention_supported" ? "success" : "info"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Analyze saved workflow evidence";
    }
  }
}

async function assessCounterfactual() {
  if (!currentRunId || !currentPlan) {
    status("Load a saved workflow before adding intervention evidence.", "error");
    return;
  }

  const payload = {
    run_id: currentRunId,
    candidate_step_id: $("cfStep")?.value.trim() || "",
    intervention_description: $("cfDescription")?.value.trim() || "",
    baseline_outcome: $("cfBaseline")?.value.trim() || "",
    intervention_outcome: $("cfOutcome")?.value.trim() || "",
    conditions_held_constant: ($("cfControls")?.value || "")
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean),
    evidence_source: $("cfSource")?.value.trim() || "",
    intervention_was_executed: Boolean($("cfExecuted")?.checked)
  };

  if (!payload.intervention_was_executed) {
    status(
      "The intervention must actually have been performed and both outcomes observed.",
      "error"
    );
    return;
  }

  if (
    !payload.candidate_step_id ||
    !payload.intervention_description ||
    !payload.baseline_outcome ||
    !payload.intervention_outcome ||
    !payload.evidence_source
  ) {
    status(
      "Enter the actual step, intervention, both observed outcomes, and evidence source. Do not guess missing values.",
      "error"
    );
    return;
  }

  if (payload.candidate_step_id.length > 40) {
    status("Candidate step ID is too long.", "error");
    return;
  }

  const button = $("counterfactualBtn");
  if (button) button.disabled = true;

  try {
    const result = await postJSON(API.counterfactual, payload);

    updateRun(result.run_id);
    renderJSON("counterfactualView", result);

    // Refresh the overall analysis after saving intervention evidence.
    await runCausalAnalysis();
  } catch (error) {
    showError(error);
  } finally {
    if (button) button.disabled = false;
  }
}

/* =========================================================
   Saved runs
   ========================================================= */

async function loadRuns(showMessage = true) {
  try {
    const result = await request(API.runs, { timeout: 20000 });
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    const target = $("runs");

    if (!target) return;

    target.replaceChildren();

    if (!runs.length) {
      target.textContent = "No saved runs yet.";
    } else {
      runs.forEach(run => {
        const row = document.createElement("div");
        row.className = "runrow";

        const title = document.createElement("strong");
        title.textContent = run.task || "Untitled task";

        const created = document.createElement("span");
        created.textContent = run.created_at || "";

        const trace = document.createElement("span");
        trace.textContent = run.has_trace ? "Trace saved" : "No trace";

        const phase = document.createElement("span");
        phase.textContent = run.phase || "plan";

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Open";
        button.addEventListener("click", () => loadRun(run.id));

        row.append(title, created, trace, phase, button);
        target.appendChild(row);
      });
    }

    if (showMessage) status("Saved runs refreshed.", "success");
  } catch (error) {
    const target = $("runs");

    if (target) {
      target.textContent = "Could not load saved runs.";
    }

    if (showMessage) showError(error);
  }
}

async function loadRun(runId) {
  try {
    const run = await request(
      `${API.runs}/${encodeURIComponent(runId)}`
    );

    updateRun(run.id);

    currentPlan = run.plan || null;
    currentRepair = run.repair || null;

    if (run.plan) {
      renderPlan(run.plan, run.id, run.model);
    }

    if ($("task")) $("task").value = run.task || "";
    if ($("issue")) $("issue").value = run.issue || "";

    if ($("traceJson")) {
      $("traceJson").value =
        Array.isArray(run.trace) && run.trace.length
          ? pretty(run.trace)
          : "";
    }

    if (run.verification) {
      renderJSON("verificationView", run.verification);
    }

    if (run.diagnosis) {
      renderJSON("diagnosisView", run.diagnosis);
      showElement("repairArea", true);
    } else {
      showElement("repairArea", false);
    }

    if (run.repair) {
      renderJSON("repairView", run.repair);
    }

    if (run.verification?.retest_assessment) {
      renderJSON(
        "retestView",
        run.verification.retest_assessment
      );
    }

    const analysis = run.verification?.causal_analysis;
    const intervention = run.verification?.intervention_assessment;

    if (analysis) {
      renderJSON("counterfactualView", analysis);

      const interventionItems = new Set([
        "intervention_evidence",
        "executed_intervention_evidence",
        "candidate_step_id",
        "intervention_description",
        "baseline_outcome",
        "intervention_outcome",
        "evidence_source",
        "controlled_conditions"
      ]);

      const needsEvidence = (analysis.missing_evidence || []).some(
        item => interventionItems.has(item.item)
      );

      showElement("additionalInterventionEvidence", needsEvidence);
    } else if (intervention) {
      renderJSON("counterfactualView", intervention);
      showElement("additionalInterventionEvidence", true);
    } else {
      showElement("additionalInterventionEvidence", false);
    }

    showElement("planPanel", true);

    status(`Loaded saved run ${run.id}.`, "success");
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   Health check and event registration
   ========================================================= */

async function healthCheck() {
  try {
    const data = await request(API.health, { timeout: 15000 });
    const serviceLabel = $("service");

    if (serviceLabel) {
      serviceLabel.textContent = data.gemini_key_configured
        ? `API ready · ${data.model}`
        : "Server online · Gemini key missing";
    }

    if (!data.gemini_key_configured) {
      status(
        "FastAPI is running, but GEMINI_API_KEY is missing or is still the placeholder.",
        "error"
      );
    }
  } catch (error) {
    if ($("service")) {
      $("service").textContent = "API offline";
    }

    status(`Cannot reach FastAPI: ${error.message}`, "error");
  }
}

function bindEvents() {
  $("planBtn")?.addEventListener("click", generatePlan);

  $("generateTraceBtn")?.addEventListener(
    "click",
    generateTraceTemplate
  );

  $("copyTraceBtn")?.addEventListener(
    "click",
    copyTraceTemplate
  );

  $("traceBtn")?.addEventListener("click", submitTrace);

  // Support both versions of the HTML button ID.
  ($("executeApisBtn") || $("executePlanBtn"))
    ?.addEventListener("click", executeConfiguredPlan);

  $("refreshToolsBtn")?.addEventListener(
    "click",
    () => loadConfiguredTools(true)
  );

  $("verifyBtn")?.addEventListener("click", verifyRun);
  $("diagnoseBtn")?.addEventListener("click", diagnose);
  $("repairBtn")?.addEventListener("click", repair);

  $("causalAnalysisBtn")?.addEventListener(
    "click",
    runCausalAnalysis
  );

  $("counterfactualBtn")?.addEventListener(
    "click",
    assessCounterfactual
  );

  $("generateRetestTraceBtn")?.addEventListener(
    "click",
    generateRetestTemplate
  );

  $("retestBtn")?.addEventListener("click", submitRetest);

  $("refreshBtn")?.addEventListener(
    "click",
    () => loadRuns(true)
  );
}

async function initialize() {
  bindEvents();

  await Promise.allSettled([
    healthCheck(),
    loadRuns(false),
    loadConfiguredTools(false)
  ]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, {
    once: true
  });
} else {
  initialize();
}

window.NSCR = {
  generatePlan,
  generateTraceTemplate,
  submitTrace,
  loadConfiguredTools,
  executeConfiguredPlan,
  verifyRun,
  diagnose,
  repair,
  runCausalAnalysis,
  assessCounterfactual,
  generateRetestTemplate,
  submitRetest,
  loadRuns,
  loadRun,
  healthCheck,
  get currentPlan() {
    return currentPlan;
  }
};