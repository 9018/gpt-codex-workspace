/**
 * project-takeover-tools.mjs — ChatGPT takeover management tools.
 *
 * Tools for managing the takeover lifecycle: take control, relinquish,
 * check takeover status, and audit the takeover history.
 *
 * @module project-takeover-tools
 */

import { validateTakeoverContext } from "./project-control-context.mjs";

/**
 * Create the takeover management tools.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} [deps.takeoverService] - Supervisor takeover service
 * @returns {object[]} Tool definitions
 */
export function createProjectTakeoverTools(deps) {
  return [
    {
      name: "project_takeover_status",
      description: "Check whether ChatGPT has direct control of this execution run and display current takeover state.",
      handler: async ({ runId } = {}) => {
        const run = await deps.runStore.readRun(runId);
        const takeoverState = {
          controller_owner: run.supervision?.controller_owner,
          run_state: run.state,
          takeover_count: run.supervision?.chatgpt_takeover_count,
          takeover_reason: run.supervision?.takeover_reason,
          worktree: run.workspace_ref,
        };
        return { ok: true, data: takeoverState };
      },
    },
    {
      name: "project_takeover_relinquish",
      description: "Relinquish ChatGPT direct control and return execution to Codex autopilot.",
      handler: async ({ runId } = {}) => {
        if (!deps.takeoverService) throw new Error("takeoverService not available");
        const { run } = await deps.takeoverService.relinquishControl({ runId });
        return {
          ok: true,
          message: `Control relinquished. Run ${run.id} is now in state "${run.state}"`,
          run_state: run.state,
        };
      },
    },
  ];
}
