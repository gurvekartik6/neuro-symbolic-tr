"use strict";

/* Builds unknown trace templates from the actual in-memory plan. */
(function () {
  const $ = id => document.getElementById(id);

  function message(text, type = "info") {
    const el = $("traceTemplateMessage");

    if (el) {
      el.textContent = text;
      el.dataset.type = type;
    }
  }

  function getSteps() {
    const plan = window.NSCR?.currentPlan;

    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      throw new Error("Generate or load a plan first.");
    }

    return plan.steps;
  }

  function buildTraceTemplate(steps) {
    return steps.map((step, index) => ({
      event_id: `trace_event_${index + 1}`,
      step_id: step.id,
      status: "unknown",
      source: "generated_template_pending_observation",
      input_observation: null,
      output_observation: null,
      preconditions_met: null,
      postconditions_met: null
    }));
  }

  function generate() {
    try {
      const steps = getSteps();
      const field = $("traceJson");

      if (!field) {
        throw new Error("Trace JSON field was not found.");
      }

      field.value = JSON.stringify(
        buildTraceTemplate(steps),
        null,
        2
      );

      message(
        `Generated ${steps.length} unknown template event(s). ` +
        "Add real observations and replace the source placeholder before submitting.",
        "success"
      );

      field.focus();
    } catch (error) {
      message(error.message || String(error), "error");
    }
  }

  async function copy() {
    const field = $("traceJson");

    if (!field?.value.trim()) {
      message("Generate the trace JSON before copying it.", "error");
      return;
    }

    try {
      JSON.parse(field.value);

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(field.value);
      } else {
        field.focus();
        field.select();

        if (!document.execCommand("copy")) {
          throw new Error(
            "Copy failed; select the JSON and copy it manually."
          );
        }
      }

      message("Trace JSON copied.", "success");
    } catch (error) {
      message(error.message || String(error), "error");
    }
  }

  function init() {
    $("generateTraceBtn")?.addEventListener("click", generate);
    $("copyTraceBtn")?.addEventListener("click", copy);
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      init,
      { once: true }
    );
  } else {
    init();
  }
})();