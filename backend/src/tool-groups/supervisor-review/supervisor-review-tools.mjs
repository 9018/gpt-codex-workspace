/**
 * supervisor-review-tools.mjs — ChatGPT review tool: list active runs for review.
 *
 * @module tool-groups/supervisor-review/supervisor-review-tools
 */

import { createControllerLease } from "../../supervisor-review/supervisor-controller-lease.mjs";

/**
 * Create tools for listing runs that need review.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.commandStore - Command store
 * @param {object} [deps.leaseManager] - Controller lease manager
 * @returns {object} Tools object
 */
export function createSupervisorReviewTools(deps) {
  if (!deps.runStore) throw new Error("runStore is required");

  return {
    /**
     * List active runs that could benefit from a ChatGPT review.
     * Does NOT call any TUI sender — purely informational.
     */
    supervisor_review_active_runs: {
      name: "supervisor_review_active_runs",
      description: "List active execution runs and their review status. Does not modify any run state or send anything to a TUI session.",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Optional: filter to a specific run ID",
          },
        },
      },
      handler: async ({ runId } = {}) => {
        const runs = [];
        const leaseManager = deps.leaseManager || createControllerLease();

        if (runId) {
          const run = await deps.runStore.readRun(runId).catch(() => null);
          if (run) {
            const lease = await leaseManager.getLease(runId);
            const pendingCommands = deps.commandStore
              ? await deps.commandStore.listPendingByRun(runId)
              : [];
            runs.push(enhanceRun(run, lease, pendingCommands));
          }
        } else {
          // Collect runs from lease manager
          const activeLeases = await leaseManager.listActiveLeases();
          for (const lease of activeLeases) {
            try {
              const run = await deps.runStore.readRun(lease.run_id);
              const pendingCommands = deps.commandStore
                ? await deps.commandStore.listPendingByRun(lease.run_id)
                : [];
              runs.push(enhanceRun(run, lease, pendingCommands));
            } catch {
              // Skip runs that can't be read
            }
          }
        }

        return { runs };
      },
    },
  };
}

function enhanceRun(run, lease, pendingCommands) {
  return {
    run_id: run.id,
    state: run.state,
    version: run.version,
    controller_owner: lease.owner,
    lease_epoch: lease.epoch,
    correction_cycles: run.supervision?.correction_cycles || 0,
    takeover_count: run.supervision?.chatgpt_takeover_count || 0,
    pending_commands: pendingCommands.length,
  };
}
