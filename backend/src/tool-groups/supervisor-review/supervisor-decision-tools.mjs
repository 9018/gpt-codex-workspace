/**
 * supervisor-decision-tools.mjs — ChatGPT decision submission tools.
 *
 * Tools for submitting ChatGPT decisions and processing them into commands.
 *
 * @module tool-groups/supervisor-review/supervisor-decision-tools
 */

import { normalizeSupervisorDecision, DECISION_ACTIONS } from "../../supervisor-review/supervisor-decision-schema.mjs";

/**
 * Create tools for submitting decisions.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.decisionStore - Decision store
 * @param {object} deps.commandStore - Command store
 * @param {object} deps.reviewRequestStore - Review request store
 * @returns {object} Tools object
 */
export function createSupervisorDecisionTools(deps) {
  if (!deps.runStore) throw new Error("runStore is required");
  if (!deps.decisionStore) throw new Error("decisionStore is required");
  if (!deps.commandStore) throw new Error("commandStore is required");

  return {
    /**
     * Submit one or more ChatGPT decisions for a specific run.
     * Each decision may produce a SupervisorCommand if the action requires it.
     * continue_codex decisions do NOT create commands.
     */
    supervisor_submit_decisions: {
      name: "supervisor_submit_decisions",
      description: "Submit ChatGPT decisions for review. continue_codex decisions produce no command. send_correction and other actions create durable commands. Partial failures are isolated per decision.",
      inputSchema: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: { type: "object" },
            description: "Array of raw decision objects",
          },
        },
        required: ["decisions"],
      },
      handler: async ({ decisions = [] } = {}) => {
        if (!Array.isArray(decisions) || decisions.length === 0) {
          return { ok: false, error: "decisions array is required" };
        }

        const results = [];

        for (const raw of decisions) {
          try {
            // Normalize the decision
            const decision = normalizeSupervisorDecision(raw);

            // Record the decision in the decision store
            const recorded = await deps.decisionStore.recordDecision(decision);

            // Create a command only for actions that produce side effects
            // continue_codex and wait do NOT create commands
            const nonCommandActions = new Set(["continue_codex", "wait"]);
            let command = null;

            if (!nonCommandActions.has(decision.action)) {
              const run = await deps.runStore.readRun(decision.run_id);
              command = await deps.commandStore.createFromDecision(decision, run);
            }

            results.push({
              decision_id: recorded.id,
              action: decision.action,
              command_created: command !== null,
              command_id: command?.id || null,
              ok: true,
            });
          } catch (err) {
            results.push({
              decision_id: raw.id || null,
              action: raw.action || null,
              ok: false,
              error: err.message,
            });
          }
        }

        const allOk = results.every((r) => r.ok);
        return {
          ok: allOk,
          results,
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        };
      },
    },
  };
}
