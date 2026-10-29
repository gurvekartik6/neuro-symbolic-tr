
"use strict";

const API = {
  health: "/api/health",
  plan: "/api/plan",
  streamPlan: "/api/plan/stream",
  trace: "/api/trace",
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

  const wrapper = document.createElement("div");
  wrapper.className = "result";
  wrapper.appendChild(pre);

  target.replaceChildren(wrapper);
  target.classList.remove("hidden");
}

function renderPlan(plan, runId, model) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("The server did not return a valid plan.");
  }

  currentPlan = plan;
  if (runId) updateRun(runId);

  const meta = $("runMeta");
  if (meta && model) {
    meta.textContent = `Run ID: ${currentRunId || "not saved"} · Model: ${model}`;
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
      p.append(strong, document.createTextNode(String(value ?? "Not provided")));
      article.appendChild(p);
    });

    container.appendChild(article);
  });

  const addList = (title, items) => {
    if (!Array.isArray(items) || items.length === 0) return;

    const h = document.createElement("h3");
    h.textContent = title;
    container.appendChild(h);

    const ul = document.createElement("ul");
    items.forEach(item => {
      const li = document.createElement("li");
      li.textContent = typeof item === "string" ? item : pretty(item);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  };

  addList("Assumptions", plan.assumptions);
  addList("Constraints", plan.constraints);
  addList("Uncertainty notes", plan.uncertainty_notes);

  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent = "This is a proposed plan. No real-world actions were executed.";
  container.appendChild(notice);

  target.replaceChildren(container);
  showElement("planPanel", true);
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
      const detail = data?.detail ?? data?.message ??
        data?.error ?? `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(typeof detail === "string" ? detail : pretty(detail));
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Could not connect to the API at ${url}. Check that FastAPI is running.`);
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

function parseSSEBlock(block) {
  let eventName = "message";
  const dataLines = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (!dataLines.length) return null;

  try {
    return { eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { eventName, data: { message: dataLines.join("\n") } };
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
      throw new Error(`Streaming endpoint returned HTTP ${response.status}: ${message}`);
    }

    if (!response.body) throw new Error("The server returned no response stream.");

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
      if (event.type === "status") status(event.message || "Gemini is working…");
      if (event.type === "delta") status("Gemini is generating your plan…");

      if (event.type === "complete") {
        if (!event.plan) throw new Error("The server reported completion without a plan.");
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
      throw new Error("The stream ended before a complete plan was received.");
    }
  } catch (error) {
    if (timedOut) throw new Error("Streaming timed out after 10 minutes. Check the API terminal and Gemini settings.");
    if (error.name === "AbortError") throw new Error("The streaming request was cancelled.");
    throw error;
  } finally {
    clearTimeout(timer);
    if (reader) {
      try { await reader.cancel(); } catch {}
    }
    if (activeController === controller) activeController = null;
  }
}

async function generatePlan() {
  if (busy) return;

  const task = $("task")?.value.trim() || "";
  if (task.length < 10) {
    status("Enter a task description containing at least 10 characters.", "error");
    return;
  }

  busy = true;
  currentRepair = null;

  [
    "diagnosisView", "repairView", "verificationView",
    "retestView", "counterfactualView"
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

  if ($("traceJson")) $("traceJson").value = pretty(events);
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
    events = JSON.parse($("traceJson").value);
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
    status(`Saved ${result.trace_event_count} trace event(s).`, "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

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
    status("Generate or load a diagnosed run before requesting repair.", "error");
    return;
  }

  try {
    const result = await postJSON(API.repair, { run_id: currentRunId });
    updateRun(result.run_id);
    currentRepair = result.repair;
    renderJSON("repairView", result.repair);
    status("Repair proposal generated. It has not been executed.", "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

function generateRetestTemplate() {
  if (!currentRepair?.revised_steps?.length) {
    status("Load a saved repair proposal or generate one before creating a retest template.", "error");
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

  if ($("retestTraceJson")) $("retestTraceJson").value = pretty(events);
  status(
    "Retest template generated with unknown outcomes. Replace placeholders with actual observations before submitting.",
    "success"
  );
}

async function submitRetest() {
  if (!currentRunId || !currentRepair?.revised_steps?.length) {
    status("Generate or load a saved repair proposal before retesting.", "error");
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

  const revisedIds = new Set(currentRepair.revised_steps.map(step => step.id));
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
      original_issue: $("issue")?.value.trim() || "Retest of the proposed repair"
    });

    updateRun(result.run_id);
    renderJSON("retestView", result.retest);
    const retestStatus = result.retest?.status || "inconclusive";
    status(`Retest saved. Status: ${retestStatus}.`, retestStatus === "retest_failed" ? "error" : "success");
    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

async function runCausalAnalysis() {
  if (!currentRunId || !currentPlan) {
    status("Generate or load a saved workflow before running causal analysis.", "error");
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

    const needsInterventionEvidence = missing.some(item =>
      interventionItems.has(item.item)
    );

    showElement("additionalInterventionEvidence", needsInterventionEvidence);

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

    // Do not stop at the form's assessment. Run the workflow analysis again.
    await runCausalAnalysis();
  } catch (error) {
    showError(error);
  } finally {
    if (button) button.disabled = false;
  }
}

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
    if (target) target.textContent = "Could not load saved runs.";
    if (showMessage) showError(error);
  }
}

async function loadRun(runId) {
  try {
    const run = await request(`${API.runs}/${encodeURIComponent(runId)}`);

    updateRun(run.id);
    currentPlan = run.plan || null;
    currentRepair = run.repair || null;

    if (run.plan) renderPlan(run.plan, run.id, run.model);
    if ($("task")) $("task").value = run.task || "";
    if ($("issue")) $("issue").value = run.issue || "";

    if ($("traceJson")) {
      $("traceJson").value = Array.isArray(run.trace) && run.trace.length
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

      const needsEvidence = (analysis.missing_evidence || []).some(item =>
        interventionItems.has(item.item)
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
      status("FastAPI is running, but GEMINI_API_KEY is missing or is still the placeholder.", "error");
    }
  } catch (error) {
    if ($("service")) $("service").textContent = "API offline";
    status(`Cannot reach FastAPI: ${error.message}`, "error");
  }
}

function bindEvents() {
  $("planBtn")?.addEventListener("click", generatePlan);
  $("generateTraceBtn")?.addEventListener("click", generateTraceTemplate);
  $("copyTraceBtn")?.addEventListener("click", copyTraceTemplate);
  $("traceBtn")?.addEventListener("click", submitTrace);
  $("verifyBtn")?.addEventListener("click", verifyRun);
  $("diagnoseBtn")?.addEventListener("click", diagnose);
  $("repairBtn")?.addEventListener("click", repair);
  $("causalAnalysisBtn")?.addEventListener("click", runCausalAnalysis);
  $("counterfactualBtn")?.addEventListener("click", assessCounterfactual);
  $("generateRetestTraceBtn")?.addEventListener("click", generateRetestTemplate);
  $("retestBtn")?.addEventListener("click", submitRetest);
  $("refreshBtn")?.addEventListener("click", () => loadRuns(true));
}

async function initialize() {
  bindEvents();
  await Promise.allSettled([healthCheck(), loadRuns(false)]);
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
  verifyRun,
  diagnose,
  repair,
  runCausalAnalysis,
  assessCounterfactual,
  generateRetestTemplate,
  submitRetest,
  get currentPlan() { return currentPlan; },
  loadRuns,
  loadRun,
  healthCheck
};
