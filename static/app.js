
"use strict";

/* =========================================================
   NS-CR Research Lab
   Frontend controller for all nine workflow steps
   ========================================================= */

const API = {
  health: "/api/health",
  plan: "/api/plan",
  streamPlan: "/api/plan/stream",
  trace: "/api/trace",
  tools: "/api/execution/tools",
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

let currentRunId = null;
let currentPlan = null;
let currentRepair = null;
let configuredTools = [];
let busy = false;

const $ = id => document.getElementById(id);
const pretty = value => JSON.stringify(value, null, 2);

function status(message, type = "info") {
  const alert = $("alert");

  if (alert) {
    alert.textContent = message;
    alert.dataset.type = type;
    alert.classList.remove("hidden");
    alert.setAttribute("role", type === "error" ? "alert" : "status");
  }

  console[type === "error" ? "error" : "log"](
    `[NS-CR ${type.toUpperCase()}] ${message}`
  );
}

function showError(error) {
  status(error?.message || String(error), "error");
}

function showElement(id, visible = true) {
  const element = $(id);
  if (element) element.classList.toggle("hidden", !visible);
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
  pre.textContent = pretty(data ?? null);
  target.replaceChildren(pre);
  target.classList.remove("hidden");
}

async function request(url, options = {}) {
  const timeout = options.timeout ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
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
        `Request timed out after ${Math.round(timeout / 60000)} minutes.`
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

function buttonBusy(button, busyText, originalText) {
  if (!button) return;

  button.disabled = busy;

  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
  } else {
    button.textContent =
      button.dataset.originalText || originalText || button.textContent;
    delete button.dataset.originalText;
  }
}

/* =========================================================
   STEP 01–02: Planning
   ========================================================= */

function renderPlan(plan, runId, model) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("The server did not return a valid plan.");
  }

  currentPlan = plan;
  currentRepair = null;

  if (runId) updateRun(runId);

  const meta = $("runMeta");
  if (meta) {
    meta.textContent =
      `Run ID: ${currentRunId || "Not saved"}` +
      (model ? ` · Model: ${model}` : "");
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
    title.textContent = `${index + 1}. ${step.action || step.id || "Step"}`;
    article.appendChild(title);

    const fields = [
      ["Step ID", step.id],
      ["Rationale", step.rationale],
      ["Expected result", step.expected_result],
      ["Risk", step.risk || "Not specified"],
      [
        "Dependencies",
        Array.isArray(step.depends_on)
          ? step.depends_on.join(", ") || "None"
          : "None"
      ],
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
    if (!Array.isArray(items) || !items.length) return;

    const subheading = document.createElement("h3");
    subheading.textContent = title;
    container.appendChild(subheading);

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
    "This is a proposed plan. Execution must be performed and verified separately.";

  container.appendChild(notice);
  target.replaceChildren(container);

  // Keep the section visible; don't hide steps 02–07 on initial load.
  showElement("planPanel", true);
  showElement("repairArea", false);
  showElement("additionalInterventionEvidence", false);

  renderExecutionBindings(configuredTools);
}

async function streamPlan(task) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(API.streamPlan, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ task }),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;

      try {
        const parsed = JSON.parse(text);
        message = parsed.detail || parsed.message || text;
      } catch {}

      throw new Error(
        `Plan endpoint returned HTTP ${response.status}: ${message}`
      );
    }

    if (!response.body) {
      throw new Error("The server returned no response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let completed = false;

    function handleBlock(block) {
      const lines = block.split(/\r?\n/);
      const dataLines = [];

      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (!dataLines.length) return;

      let event;

      try {
        event = JSON.parse(dataLines.join("\n"));
      } catch {
        throw new Error("The server returned an invalid streaming event.");
      }

      if (event.type === "error") {
        throw new Error(event.message || "Plan generation failed.");
      }

      if (event.type === "status") {
        status(event.message || "Gemini is working…");
      }

      if (event.type === "complete") {
        if (!event.plan) {
          throw new Error("The server completed without returning a plan.");
        }

        renderPlan(event.plan, event.run_id, event.model);
        completed = true;
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      for (const block of blocks) handleBlock(block);
    }

    buffer += decoder.decode();

    if (buffer.trim()) handleBlock(buffer);

    if (!completed) {
      throw new Error(
        "The streaming connection ended before a complete plan was received."
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function generatePlan() {
  if (busy) return;

  const task = $("task")?.value.trim() || "";

  if (task.length < 10) {
    status("Enter a task description of at least 10 characters.", "error");
    return;
  }

  busy = true;
  const button = $("planBtn");
  buttonBusy(button, "Generating plan…");

  [
    "planView",
    "executionTraceView",
    "verificationView",
    "diagnosisView",
    "repairView",
    "retestView",
    "counterfactualView"
  ].forEach(id => $(id)?.replaceChildren());

  showElement("repairArea", false);
  showElement("additionalInterventionEvidence", false);

  try {
    status("Connecting to Gemini…");
    await streamPlan(task);
    status("Plan generated and saved.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    buttonBusy(button, "", "Generate plan with Gemini");
  }
}

/* =========================================================
   STEP 03: API tools and execution
   ========================================================= */

async function loadConfiguredTools(showMessage = false) {
  try {
    const result = await request(API.tools, { timeout: 15000 });

    configuredTools = Array.isArray(result?.tools)
      ? result.tools
      : Array.isArray(result)
        ? result
        : [];

    const message = $("executionToolStatus");

    if (message) {
      message.textContent = configuredTools.length
        ? `${configuredTools.length} configured API tool(s) available.`
        : "No API tools configured. Configure NSCR_HTTP_TOOLS_JSON in the server .env file.";
    }

    renderExecutionBindings(configuredTools);

    if (showMessage) {
      status("Configured API tools refreshed.", "success");
    }
  } catch (error) {
    const message = $("executionToolStatus");

    if (message) {
      message.textContent = `Could not load API tools: ${error.message}`;
    }

    if (showMessage) showError(error);
  }
}

function renderExecutionBindings(tools) {
  const container = $("executionBindings");
  if (!container) return;

  if (!currentPlan?.steps?.length) {
    container.replaceChildren();

    const note = document.createElement("p");
    note.className = "trace-help";
    note.textContent =
      "Generate or open a plan before binding its steps to API tools.";
    container.appendChild(note);
    return;
  }

  const oldValues = new Map();

  container.querySelectorAll("select[data-step-id]").forEach(select => {
    const id = select.dataset.stepId;
    const field = Array.from(
      container.querySelectorAll("textarea[data-params-step]")
    ).find(item => item.dataset.paramsStep === id);

    oldValues.set(id, {
      tool: select.value,
      parameters: field?.value || "{}"
    });
  });

  container.replaceChildren();

  if (!tools.length) {
    const note = document.createElement("p");
    note.className = "trace-help";
    note.textContent =
      "No API tools are configured. Execution will remain unavailable until tools are configured on the server.";
    container.appendChild(note);
    return;
  }

  currentPlan.steps.forEach((step, index) => {
    const card = document.createElement("section");
    card.className = "execution-binding";

    const title = document.createElement("h3");
    title.textContent = `${index + 1}. ${step.action || step.id}`;
    card.appendChild(title);

    const label = document.createElement("label");
    label.textContent = "Configured API tool";
    card.appendChild(label);

    const select = document.createElement("select");
    select.dataset.stepId = step.id;
    select.setAttribute("aria-label", `API tool for ${step.id}`);

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Skip this step";
    select.appendChild(none);

    tools.forEach(tool => {
      if (!tool.name) return;

      const option = document.createElement("option");
      option.value = tool.name;
      option.textContent = [
        tool.name,
        tool.method || "HTTP",
        tool.host || ""
      ].filter(Boolean).join(" · ");

      select.appendChild(option);
    });

    const previous = oldValues.get(step.id);

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
    params.placeholder = "{}";
    params.value = previous?.parameters || "{}";
    card.appendChild(params);

    const help = document.createElement("p");
    help.className = "trace-help";
    help.textContent =
      "Only enter parameters accepted by the selected server-side tool.";
    card.appendChild(help);

    container.appendChild(card);
  });
}

function readExecutionBindings() {
  const container = $("executionBindings");

  if (!container) {
    throw new Error("The execution bindings control was not found.");
  }

  const bindings = [];

  container.querySelectorAll("select[data-step-id]").forEach(select => {
    if (!select.value) return;

    const stepId = select.dataset.stepId;

    const field = Array.from(
      container.querySelectorAll("textarea[data-params-step]")
    ).find(item => item.dataset.paramsStep === stepId);

    let parameters;

    try {
      parameters = JSON.parse(field?.value.trim() || "{}");
    } catch {
      throw new Error(`Parameters for ${stepId} must be valid JSON.`);
    }

    if (
      !parameters ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    ) {
      throw new Error(`Parameters for ${stepId} must be a JSON object.`);
    }

    bindings.push({
      step_id: stepId,
      tool_name: select.value,
      parameters
    });
  });

  return bindings;
}

async function executeConfiguredPlan() {
  if (busy) return;

  if (!currentRunId || !currentPlan) {
    status("Generate or open a saved plan before executing APIs.", "error");
    return;
  }

  let bindings;

  try {
    bindings = readExecutionBindings();
  } catch (error) {
    showError(error);
    return;
  }

  if (!bindings.length) {
    status("Select at least one API tool before executing.", "error");
    return;
  }

  if (bindings.length > 20) {
    status("A maximum of 20 API bindings can be submitted at once.", "error");
    return;
  }

  const confirmExternal = Boolean($("confirmExternalActions")?.checked);

  const confirmed = window.confirm(
    "Review the selected tools and parameters before continuing. " +
    "This may call external APIs. Continue?"
  );

  if (!confirmed) return;

  busy = true;

  const button = $("executeApisBtn");
  buttonBusy(button, "Executing APIs…");

  try {
    const result = await postJSON(API.execute, {
      run_id: currentRunId,
      bindings,
      confirm_external_actions: confirmExternal
    });

    updateRun(result.run_id);

    const events = Array.isArray(result.trace_events)
      ? result.trace_events
      : [];

    renderJSON("executionTraceView", {
      trace_event_count: result.trace_event_count ?? events.length,
      trace_events: events,
      notice: result.notice
    });

    if ($("traceJson")) {
      $("traceJson").value = pretty(events);
    }

    if (result.verification) {
      renderJSON("verificationView", result.verification);
    }

    status(
      `Execution finished. ${events.length} trace event(s) recorded.`,
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    buttonBusy(button, "", "Execute configured APIs and capture trace");
  }
}

/* =========================================================
   Trace template and manual trace submission
   ========================================================= */

function generateTraceTemplate() {
  if (!currentPlan?.steps?.length) {
    status("Generate a plan before creating a trace template.", "error");
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

  if ($("traceJson")) $("traceJson").value = pretty(events);

  if ($("traceTemplateMessage")) {
    $("traceTemplateMessage").textContent =
      "Replace placeholders only with genuine observations.";
  }

  status("Trace template created. No execution is implied.", "success");
}

async function copyTraceTemplate() {
  const text = $("traceJson")?.value || "";

  if (!text) {
    status("Generate or enter trace JSON before copying.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    status("Trace JSON copied.", "success");
  } catch {
    status("Clipboard unavailable. Select and copy the JSON manually.", "error");
  }
}

async function submitTrace() {
  if (!currentRunId) {
    status("Generate or open a saved run first.", "error");
    return;
  }

  let events;

  try {
    events = JSON.parse($("traceJson")?.value || "");
  } catch {
    status("Trace JSON is invalid.", "error");
    return;
  }

  if (!Array.isArray(events) || !events.length) {
    status("Trace must be a non-empty JSON array.", "error");
    return;
  }

  try {
    const result = await postJSON(API.trace, {
      run_id: currentRunId,
      events
    });

    updateRun(result.run_id);

    if (result.verification) {
      renderJSON("verificationView", result.verification);
    }

    status("Trace submitted and saved.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   STEP 04: Verification and diagnosis
   ========================================================= */

async function verifyRun() {
  if (!currentRunId) {
    status("Generate or open a saved run first.", "error");
    return;
  }

  try {
    const result = await postJSON(API.verify, {
      run_id: currentRunId,
      issue: $("issue")?.value.trim() || ""
    });

    updateRun(result.run_id);

    if (result.verification) {
      renderJSON("verificationView", result.verification);
    }

    status("Verification completed.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

async function diagnose() {
  if (!currentRunId) {
    status("Generate or open a saved run before diagnosis.", "error");
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
      "Diagnosis saved. Treat the proposed root cause as a hypothesis until supported by evidence.",
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   STEP 05: Repair proposal
   ========================================================= */

async function repair() {
  if (!currentRunId) {
    status("Generate or open a diagnosed run first.", "error");
    return;
  }

  try {
    const result = await postJSON(API.repair, {
      run_id: currentRunId
    });

    updateRun(result.run_id);
    currentRepair = result.repair || null;

    renderJSON("repairView", result.repair);

    status(
      "Repair proposal saved. It has not been executed automatically.",
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   STEP 06: Causal analysis and intervention evidence
   ========================================================= */

async function runCausalAnalysis() {
  if (!currentRunId) {
    status("Generate or open a saved workflow first.", "error");
    return;
  }

  const button = $("causalAnalysisBtn");
  buttonBusy(button, "Analyzing evidence…");

  try {
    const result = await postJSON(API.causalAnalysis, {
      run_id: currentRunId
    });

    updateRun(result.run_id);
    renderJSON("counterfactualView", result);

    const interventionFields = new Set([
      "intervention_evidence",
      "executed_intervention_evidence",
      "candidate_step_id",
      "intervention_description",
      "baseline_outcome",
      "intervention_outcome",
      "evidence_source",
      "controlled_conditions"
    ]);

    const missing = Array.isArray(result.missing_evidence)
      ? result.missing_evidence
      : [];

    showElement(
      "additionalInterventionEvidence",
      missing.some(item => interventionFields.has(item.item))
    );

    status(
      `Causal analysis finished. Status: ${result.status || "undetermined"}.`,
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    buttonBusy(button, "", "Analyze saved workflow evidence");
  }
}

async function assessCounterfactual() {
  if (!currentRunId || !currentPlan) {
    status("Open a saved workflow before submitting intervention evidence.", "error");
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
      "Confirm that the intervention was actually performed before submitting its outcomes.",
      "error"
    );
    return;
  }

  const required = [
    "candidate_step_id",
    "intervention_description",
    "baseline_outcome",
    "intervention_outcome",
    "evidence_source"
  ];

  if (required.some(key => !payload[key])) {
    status(
      "Complete the step ID, intervention, both outcomes, and evidence source.",
      "error"
    );
    return;
  }

  if (payload.candidate_step_id.length > 40) {
    status("Candidate step ID is too long.", "error");
    return;
  }

  const button = $("counterfactualBtn");
  buttonBusy(button, "Saving evidence…");

  try {
    const result = await postJSON(API.counterfactual, payload);

    updateRun(result.run_id);
    renderJSON("counterfactualView", result);

    status("Intervention assessment saved.", "success");
    await runCausalAnalysis();
  } catch (error) {
    showError(error);
  } finally {
    buttonBusy(button, "", "Save evidence and re-analyze");
  }
}

/* =========================================================
   STEP 07: Retest
   ========================================================= */

function generateRetestTemplate() {
  const steps = currentRepair?.revised_steps;

  if (!Array.isArray(steps) || !steps.length) {
    status(
      "Generate or open a repair proposal with revised steps first.",
      "error"
    );
    return;
  }

  const events = steps.map((step, index) => ({
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
    "Retest template generated. Replace unknown outcomes with real observations.",
    "success"
  );
}

async function submitRetest() {
  if (!currentRunId || !currentPlan || !currentRepair?.revised_steps?.length) {
    status(
      "Open a plan and repair proposal before submitting a retest.",
      "error"
    );
    return;
  }

  let events;

  try {
    events = JSON.parse($("retestTraceJson")?.value || "");
  } catch {
    status("Retest JSON is invalid.", "error");
    return;
  }

  if (!Array.isArray(events) || !events.length) {
    status("Retest events must be a non-empty JSON array.", "error");
    return;
  }

  const revisedPlan = {
    ...currentPlan,
    steps: currentRepair.revised_steps
  };

  const button = $("retestBtn");
  buttonBusy(button, "Validating retest…");

  try {
    const result = await postJSON(API.retest, {
      source_run_id: currentRunId,
      revised_plan: revisedPlan,
      events,
      original_issue: $("issue")?.value.trim() || "Repair retest"
    });

    updateRun(result.run_id);
    renderJSON("retestView", result.retest);

    status(
      "Retest saved. Review the assessment before concluding that the repair worked.",
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  } finally {
    buttonBusy(button, "", "Validate and save retest");
  }
}

/* =========================================================
   STEP 08: Workflow history and evidence audit
   ========================================================= */

function summarizeRun(run) {
  const verification =
    run?.verification && typeof run.verification === "object"
      ? run.verification
      : {};

  const retest =
    verification.retest_assessment ||
    verification.retest ||
    {};

  return {
    ...run,
    has_trace: typeof run?.has_trace === "boolean"
      ? run.has_trace
      : Array.isArray(run?.trace) && run.trace.length > 0,
    diagnosed: typeof run?.diagnosed === "boolean"
      ? run.diagnosed
      : Boolean(run?.diagnosis),
    repaired: typeof run?.repaired === "boolean"
      ? run.repaired
      : Boolean(run?.repair),
    retest_status: run?.retest_status || retest?.status || null
  };
}

async function loadRuns(showMessage = true) {
  try {
    const result = await request(API.runs, { timeout: 20000 });
    const runs = Array.isArray(result?.runs)
      ? result.runs.map(summarizeRun)
      : [];

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

        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Open";
        open.addEventListener("click", () => loadRun(run.id));

        row.append(title, created, trace, phase, open);
        target.appendChild(row);
      });
    }

    if (showMessage) status("Saved runs refreshed.", "success");
  } catch (error) {
    const target = $("runs");
    if (target) target.textContent = "Could not load saved runs.";
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

    if ($("task")) $("task").value = run.task || "";
    if ($("issue")) $("issue").value = run.issue || "";

    if (run.plan) renderPlan(run.plan, run.id, run.model);

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

    if (run.repair) renderJSON("repairView", run.repair);

    if (run.verification?.retest_assessment) {
      renderJSON("retestView", run.verification.retest_assessment);
    }

    if (run.verification?.causal_analysis) {
      renderJSON("counterfactualView", run.verification.causal_analysis);
    } else if (run.verification?.intervention_assessment) {
      renderJSON("counterfactualView", run.verification.intervention_assessment);
    }

    showElement("planPanel", true);

    status(`Loaded saved run ${run.id}.`, "success");
  } catch (error) {
    showError(error);
  }
}

async function loadWorkflowHistory() {
  if (!currentRunId) {
    status("Generate or open a saved run first.", "error");
    return;
  }

  try {
    const selected = await request(
      `${API.runs}/${encodeURIComponent(currentRunId)}`
    );

    const workflowId = selected.workflow_id || selected.id;

    const result = await request(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs`
    );

    const history = Array.isArray(result?.runs)
      ? result.runs.map(summarizeRun)
      : [];

    const target = $("workflowHistoryView");
    if (!target) return;

    target.replaceChildren();

    const intro = document.createElement("p");
    intro.textContent =
      `Workflow ID: ${workflowId}. ${history.length} saved record(s).`;
    target.appendChild(intro);

    if (!history.length) {
      const empty = document.createElement("p");
      empty.textContent = "No saved runs were returned for this workflow.";
      target.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "audit-table";

    const headers = [
      "Created",
      "Phase",
      "Run ID",
      "Parent run",
      "Trace",
      "Diagnosis",
      "Repair",
      "Retest",
      "Action"
    ];

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    headers.forEach(text => {
      const th = document.createElement("th");
      th.textContent = text;
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    history.forEach(run => {
      const tr = document.createElement("tr");

      const values = [
        run.created_at,
        run.phase,
        run.id,
        run.parent_run_id || "None",
        run.has_trace ? "Saved" : "Not saved",
        run.diagnosed ? "Saved" : "Not saved",
        run.repaired ? "Saved" : "Not saved",
        run.retest_status || "Not recorded"
      ];

      values.forEach(value => {
        const td = document.createElement("td");
        td.textContent = value == null ? "Not recorded" : String(value);
        tr.appendChild(td);
      });

      const action = document.createElement("td");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary";
      open.textContent = "Open";
      open.addEventListener("click", () => loadRun(run.id));
      action.appendChild(open);
      tr.appendChild(action);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    target.appendChild(table);

    status("Workflow history loaded from saved records.", "success");
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   STEP 09: Evidence comparison and CSV export
   ========================================================= */

async function getCurrentWorkflowHistory() {
  if (!currentRunId) {
    throw new Error("Generate or open a saved run first.");
  }

  const selected = await request(
    `${API.runs}/${encodeURIComponent(currentRunId)}`
  );

  const workflowId = selected.workflow_id || selected.id;

  const result = await request(
    `/api/workflows/${encodeURIComponent(workflowId)}/runs`
  );

  return {
    workflowId,
    runs: Array.isArray(result?.runs)
      ? result.runs.map(summarizeRun)
      : []
  };
}

async function buildPolicyComparison() {
  try {
    const { workflowId, runs } = await getCurrentWorkflowHistory();

    const hasTrace = runs.some(run => run.has_trace);
    const hasDiagnosis = runs.some(run => run.diagnosed);
    const hasRepair = runs.some(run => run.repaired);
    const retestRun = [...runs].reverse().find(run => run.retest_status);

    const rows = [
      [
        "Baseline / no recovery",
        "Not evaluated",
        "No separate controlled baseline trial is recorded."
      ],
      [
        "Reflection / retry",
        "Not evaluated",
        "No separate executed trial is recorded."
      ],
      [
        "Verify + full restart",
        "Not evaluated",
        "No separate executed trial is recorded."
      ],
      [
        "NS-CR evidence-guided workflow",
        hasTrace || hasDiagnosis || hasRepair
          ? "Evidence available"
          : "Insufficient saved evidence",
        [
          `Trace: ${hasTrace ? "recorded" : "not recorded"}`,
          `Diagnosis: ${hasDiagnosis ? "recorded" : "not recorded"}`,
          `Repair: ${hasRepair ? "recorded" : "not recorded"}`,
          `Retest: ${retestRun?.retest_status || "not recorded"}`
        ].join("; ")
      ]
    ];

    const target = $("policyComparisonView");
    if (!target) return;

    target.replaceChildren();

    const note = document.createElement("p");
    note.textContent =
      `Workflow ${workflowId}. This is an evidence-availability summary, not a benchmark.`;
    target.appendChild(note);

    const table = document.createElement("table");
    table.className = "audit-table";

    const thead = document.createElement("thead");
    const header = document.createElement("tr");

    ["Policy", "Status", "Evidence / limitation"].forEach(text => {
      const th = document.createElement("th");
      th.textContent = text;
      header.appendChild(th);
    });

    thead.appendChild(header);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    rows.forEach(values => {
      const tr = document.createElement("tr");

      values.forEach(value => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    target.appendChild(table);

    status("Evidence comparison built without inventing trial results.", "success");
  } catch (error) {
    showError(error);
  }
}

function csvEscape(value) {
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return `"${text.replace(/"/g, '""')}"`;
}

async function exportWorkflowCsv() {
  try {
    const { workflowId, runs } = await getCurrentWorkflowHistory();

    const rows = [[
      "workflow_id",
      "run_id",
      "parent_run_id",
      "created_at",
      "phase",
      "task",
      "has_trace",
      "diagnosed",
      "repaired",
      "retest_status"
    ]];

    runs.forEach(run => {
      rows.push([
        workflowId,
        run.id,
        run.parent_run_id || "",
        run.created_at || "",
        run.phase || "",
        run.task || "",
        run.has_trace,
        run.diagnosed,
        run.repaired,
        run.retest_status || ""
      ]);
    });

    const csv = rows
      .map(row => row.map(csvEscape).join(","))
      .join("\r\n");

    const blob = new Blob(
      ["\uFEFF", csv],
      { type: "text/csv;charset=utf-8;" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `nscr-workflow-${workflowId.slice(0, 8)}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    status(`Exported ${runs.length} saved record(s) to CSV.`, "success");
  } catch (error) {
    showError(error);
  }
}

/* =========================================================
   Health check and event binding
   ========================================================= */

async function healthCheck() {
  try {
    const data = await request(API.health, { timeout: 15000 });
    const service = $("service");

    if (service) {
      service.textContent = data.gemini_key_configured
        ? `API ready · ${data.model || "Gemini"}`
        : "Server online · Gemini key missing";
    }

    if (!data.gemini_key_configured) {
      status(
        "FastAPI is running, but GEMINI_API_KEY is missing or is a placeholder.",
        "error"
      );
    }
  } catch (error) {
    if ($("service")) $("service").textContent = "API offline";
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
  $("executeApisBtn")?.addEventListener("click", executeConfiguredPlan);
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

  $("workflowHistoryBtn")?.addEventListener(
    "click",
    loadWorkflowHistory
  );

  $("comparePoliciesBtn")?.addEventListener(
    "click",
    buildPolicyComparison
  );

  $("exportWorkflowCsvBtn")?.addEventListener(
    "click",
    exportWorkflowCsv
  );

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
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
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
  loadWorkflowHistory,
  buildPolicyComparison,
  exportWorkflowCsv,
  healthCheck,
  get currentPlan() {
    return currentPlan;
  }
};