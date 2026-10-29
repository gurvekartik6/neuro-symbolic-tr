
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
  runs: "/api/runs"
};

const REQUEST_TIMEOUT_MS = 600000;
const STREAM_TIMEOUT_MS = 600000;

let currentRunId = null;
let currentPlan = null;
let activeController = null;
let busy = false;

const $ = id => document.getElementById(id);
const pretty = value => JSON.stringify(value, null, 2);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

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

  const text = pretty(data);

  // JSON is displayed as text, never interpreted as HTML.
  target.replaceChildren();

  const wrapper = document.createElement("div");
  wrapper.className = "result";

  const pre = document.createElement("pre");
  pre.textContent = text;

  wrapper.appendChild(pre);
  target.appendChild(wrapper);
  target.classList.remove("hidden");
}

function renderPlan(plan, runId, model) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error(
      "The server did not return a valid plan containing a steps array."
    );
  }

  currentPlan = plan;
  if (runId) updateRun(runId);

  const meta = $("runMeta");
  if (meta && model) {
    meta.textContent =
      `Run ID: ${currentRunId || "not saved"} · Model: ${model}`;
  }

  const target = $("planView");
  if (!target) {
    console.warn("Missing #planView in static/index.html.");
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = plan.task_summary || "Generated plan";

  const container = document.createElement("div");
  container.className = "result";

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

    const heading = document.createElement("h3");
    heading.textContent = title;
    container.appendChild(heading);

    const list = document.createElement("ul");

    items.forEach(item => {
      const li = document.createElement("li");
      li.textContent = typeof item === "string" ? item : pretty(item);
      list.appendChild(li);
    });

    container.appendChild(list);
  };

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

  try {
    const response = await fetch(url, {
      ...options,
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
        `Request timed out after ${Math.round(timeoutMs / 60000)} minutes. ` +
        "Check the FastAPI terminal and Gemini API response."
      );
    }

    if (error instanceof TypeError) {
      throw new Error(
        `Could not connect to the API at ${url}. ` +
        "Check that FastAPI is running and that you opened its URL."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postJSON(url, payload) {
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

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;

  const raw = dataLines.join("\n");

  try {
    return { eventName, data: JSON.parse(raw) };
  } catch {
    return { eventName, data: { message: raw } };
  }
}

async function streamPlan(payload) {
  if (activeController) activeController.abort();

  const controller = new AbortController();
  activeController = controller;

  let timedOut = false;
  let reader = null;

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
      let detail = raw;

      try {
        const parsed = JSON.parse(raw);
        detail = parsed.detail || parsed.message || raw;
      } catch {
        // Use the response text if it is not JSON.
      }

      throw new Error(
        `Streaming endpoint returned HTTP ${response.status}: ` +
        `${typeof detail === "string" ? detail : pretty(detail)}`
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
        throw new Error(
          event.message || "The Gemini streaming request failed."
        );
      }

      if (event.type === "status") {
        status(event.message || "Gemini is working…");
        return;
      }

      if (event.type === "delta") {
        status("Gemini is generating your plan…");
        return;
      }

      if (event.type === "complete") {
        if (!event.plan) {
          throw new Error(
            "The server reported completion without a plan."
          );
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

      for (const block of blocks) {
        processBlock(block);
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      processBlock(buffer);
    }

    if (!completed) {
      throw new Error(
        "The stream ended before a complete plan was received. " +
        "Check the FastAPI terminal for a Gemini error."
      );
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(
        "Streaming timed out after 10 minutes. Check the FastAPI terminal, " +
        "Gemini API key, model name, quota, and network connection."
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
      } catch {
        // The stream may already be closed.
      }
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
    status("Enter a task description containing at least 10 characters.", "error");
    return;
  }

  busy = true;

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

function showError(error) {
  status(error?.message || String(error), "error");
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
    status("Enter a non-empty array of actual trace events.", "error");
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
      `Saved ${result.trace_event_count} trace event(s).`,
      "success"
    );

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
    const result = await postJSON(API.repair, {
      run_id: currentRunId
    });

    updateRun(result.run_id);
    renderJSON("repairView", result.repair);

    status(
      "Repair proposal generated. It has not been executed.",
      "success"
    );

    await loadRuns(false);
  } catch (error) {
    showError(error);
  }
}

async function loadRuns(showMessage = true) {
  try {
    const result = await request(API.runs, { timeout: 20000 });
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    const target = $("runs");

    if (!target) return;

    target.replaceChildren();

    if (runs.length === 0) {
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

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Open";
        button.addEventListener("click", () => loadRun(run.id));

        row.append(title, created, trace, button);
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

    showElement("planPanel", true);
    status(`Loaded saved run ${run.id}.`, "success");
  } catch (error) {
    showError(error);
  }
}

async function healthCheck() {
  try {
    const data = await request(API.health, { timeout: 15000 });
    const service = $("service");

    if (service) {
      service.textContent = data.gemini_key_configured
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
    const service = $("service");
    if (service) service.textContent = "API offline";

    status(`Cannot reach FastAPI: ${error.message}`, "error");
  }
}

function bindEvents() {
  $("planBtn")?.addEventListener("click", generatePlan);
  $("traceBtn")?.addEventListener("click", submitTrace);
  $("diagnoseBtn")?.addEventListener("click", diagnose);
  $("repairBtn")?.addEventListener("click", repair);
  $("refreshBtn")?.addEventListener("click", () => loadRuns(true));
}

async function initialize() {
  bindEvents();

  await Promise.allSettled([
    healthCheck(),
    loadRuns(false)
  ]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

window.NSCR = {
  generatePlan,
  submitTrace,
  verifyRun,
  diagnose,
  repair,
  loadRuns,
  loadRun,
  healthCheck
};
