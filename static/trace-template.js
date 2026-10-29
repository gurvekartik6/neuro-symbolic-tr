
"use strict";

/*
 * NS-CR automatic trace-template generator.
 *
 * Reads step IDs from the currently displayed plan.
 * Generated entries are UNKNOWN templates, not execution evidence.
 */

(function () {
    const $ = (id) => document.getElementById(id);

    function showMessage(message, type = "info") {
        const element = $("traceTemplateMessage");

        if (element) {
            element.textContent = message;
            element.dataset.type = type;
        }

        console.log(`[NS-CR Trace] ${message}`);
    }

    function getStepIdsFromDisplayedPlan() {
        const planPanel = $("planPanel");
        const planView = $("planView");

        if (!planPanel || !planView || planPanel.classList.contains("hidden")) {
            throw new Error(
                "No generated plan is displayed. Generate a plan in Step 01 first."
            );
        }

        const planText = planView.innerText || planView.textContent || "";

        // Match IDs such as step_1, step_2, step_10.
        const matches = planText.match(/\bstep_[a-zA-Z0-9_-]+\b/g) || [];
        const uniqueIds = [...new Set(matches)];

        if (uniqueIds.length === 0) {
            throw new Error(
                "Could not find step IDs in the displayed plan. " +
                "Check that the plan contains IDs such as step_1 and step_2."
            );
        }

        return uniqueIds;
    }

    function buildTraceTemplate(stepIds) {
        return stepIds.map((stepId, index) => ({
            event_id: `trace_event_${index + 1}`,
            step_id: stepId,
            status: "unknown",
            source: "generated_template_pending_observation",
            input_observation: null,
            output_observation: null,
            preconditions_met: null,
            postconditions_met: null
        }));
    }

    function generateTraceJSON() {
        try {
            const stepIds = getStepIdsFromDisplayedPlan();
            const events = buildTraceTemplate(stepIds);
            const textarea = $("traceJson");

            if (!textarea) {
                throw new Error(
                    "The Execution trace JSON field was not found."
                );
            }

            textarea.value = JSON.stringify(events, null, 2);

            showMessage(
                `Generated ${events.length} template event(s) for: ` +
                `${stepIds.join(", ")}. These are unverified templates. ` +
                "Add actual observations before submitting evidence.",
                "success"
            );

            textarea.focus();
        } catch (error) {
            showMessage(error.message || String(error), "error");
        }
    }

    async function copyTraceJSON() {
        const textarea = $("traceJson");

        if (!textarea || !textarea.value.trim()) {
            showMessage("Generate the trace JSON before copying it.", "error");
            return;
        }

        try {
            // Ensure the current content is valid JSON.
            JSON.parse(textarea.value);

            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(textarea.value);
            } else {
                textarea.focus();
                textarea.select();

                if (!document.execCommand("copy")) {
                    throw new Error(
                        "Copy was unsuccessful. Select the JSON and copy it manually."
                    );
                }
            }

            showMessage("Trace JSON copied.", "success");
        } catch (error) {
            showMessage(error.message || String(error), "error");
        }
    }

    function initialize() {
        const generateButton = $("generateTraceBtn");
        const copyButton = $("copyTraceBtn");

        if (generateButton) {
            generateButton.addEventListener("click", generateTraceJSON);
        } else {
            console.error("NS-CR: generateTraceBtn was not found.");
        }

        if (copyButton) {
            copyButton.addEventListener("click", copyTraceJSON);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, {
            once: true
        });
    } else {
        initialize();
    }
})();
