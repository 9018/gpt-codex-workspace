/**
 * supervisor-review-tools.mjs — ChatGPT review tools: list runs needing review and get review packets.
 *
 * @module tool-groups/supervisor-review/supervisor-review-tools
 */

import { createControllerLease } from "../../supervisor-review/supervisor-controller-lease.mjs";

/**
 * Create tools for reviewing runs.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store (must support listRuns({state}) and readRun(id))
 * @param {object} deps.commandStore - Command store
 * @param {object} [deps.leaseManager] - Controller lease manager
 * @param {object} [deps.reviewPacketBuilder] - Optional review packet builder for enriched data
 * @returns {object} Tools object
 */
export function createSupervisorReviewTools(deps) {
  if (!deps.runStore) throw new Error("runStore is required");

  /** States that should be visible for supervisor review. */
  const ACTIVE_REVIEW_STATES = [
    "running", "collecting", "evaluating",
    "waiting_for_repair", "waiting_for_supervisor",
    "chatgpt_direct",
  ];

  return {
    /**
     * List runs that could need ChatGPT review, ordered by activity.
     * Primary source is the Run Store (all active states), with lease info
     * as supplementary metadata.
     */
    supervisor_review_active_runs: {
      name: "supervisor_review_active_runs",
      description: "List runs that might need ChatGPT review. Shows all runs in active states (running, waiting_for_supervisor, chatgpt_direct, etc.) with their checkpoints, commands, and lease status. Does not modify state.",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Optional: filter to a specific run ID",
          },
          include_requests: {
            type: "boolean",
            description: "Optional: include pending review request details. Default: false.",
            default: false,
          },
        },
      },
      handler: async ({ runId, include_requests } = {}) => {
        const leaseManager = deps.leaseManager || createControllerLease();
        const runs = [];

        if (runId) {
          const run = await deps.runStore.readRun(runId).catch(() => null);
          if (run) {
            const lease = await leaseManager.getLease(runId);
            const pendingCommands = deps.commandStore
              ? await deps.commandStore.listPendingByRun(runId)
              : [];
            runs.push(await enrichRun(run, lease, pendingCommands, deps));
          }
        } else {
          // Primary source: Run Store enumeration by active states
          const activeRunStates = [
            "running", "collecting", "evaluating",
            "waiting_for_repair", "waiting_for_supervisor",
            "chatgpt_direct",
          ];
          let activeRuns;
          try {
            activeRuns = await deps.runStore.listRuns({ state: activeRunStates });
          } catch {
            // Fallback: listRuns may not be available; use lease-based enumeration
            const activeLeases = await leaseManager.listActiveLeases();
            activeRuns = [];
            for (const lease of activeLeases) {
              try {
                const run = await deps.runStore.readRun(lease.run_id);
                activeRuns.push(run);
              } catch { /* skip */ }
            }
          }

          for (const run of activeRuns) {
            const lease = await leaseManager.getLease(run.id);
            const pendingCommands = deps.commandStore
              ? await deps.commandStore.listPendingByRun(run.id)
              : [];
            runs.push(await enrichRun(run, lease, pendingCommands, deps));
          }
        }

        return {
          total_runs: runs.length,
          runs,
          fetched_at: new Date().toISOString(),
        };
      },
    },
  };
}

/**
 * Enrich a run with lease data, pending commands, and optional review packet.
 */
async function enrichRun(run, lease, pendingCommands, deps) {
  const base = {
    run_id: run.id,
    state: run.state,
    version: run.version,
    controller_owner: lease.owner,
    lease_epoch: lease.epoch,
    correction_cycles: run.supervision?.correction_cycles || 0,
    takeover_count: run.supervision?.chatgpt_takeover_count || 0,
    awaiting_correction_progress: !!run.supervision?.awaiting_progress_after_correction,
    pending_commands: pendingCommands.length,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };

  // Add checkpoint summary if available
  if (run.checkpoint_ids?.length) {
    base.checkpoint_count = run.checkpoint_ids.length;
    base.last_checkpoint_id = run.checkpoint_ids[run.checkpoint_ids.length - 1];
  }

  // Add supervisor plan info
  if (run.supervisor_plan_id) {
    base.supervisor_plan_id = run.supervisor_plan_id;
  }

  // Optionally enrich with full review packet
  if (deps.reviewPacketBuilder) {
    try {
      const packet = await deps.reviewPacketBuilder.build({ runId: run.id });
      if (packet) {
        base.packet = {
          goal: packet.goal || null,
          plan_summary: packet.plan_summary || null,
          architecture_constraints: packet.architecture_constraints || null,
          changed_files: packet.repository?.changed_files || [],
          diff_summary: packet.repository?.diff_summary || null,
          test_results: packet.test_results || null,
          progress: packet.progress || null,
          previous_decisions: packet.priorDecisions || [],
          evidence_gaps: packet.evidenceGaps || [],
        };
      }
    } catch {
      // Non-fatal: packet building may fail
    }
  }

  return base;
}
