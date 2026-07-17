/**
 * supervisor-policy-engine.mjs — Policy engine for supervisor decisions.
 *
 * Evaluates the current run state, checkpoint history, and autonomy
 * budget to determine the next supervisory action.
 *
 * @module supervisor-policy-engine
 */

import { SupervisorPolicyError } from "./supervisor-errors.mjs";
import { CHECKPOINT_ACTIONS, CHECKPOINT_VERDICTS } from "./supervisor-checkpoint-schema.mjs";

/**
 * Create the supervisor policy engine.
 *
 * @returns {object} Policy engine API
 */
export function createSupervisorPolicyEngine() {
  /**
   * Determine the next action based on checkpoint verdict and run state.
   *
   * @param {object} options
   * @param {string} options.verdict - Checkpoint verdict
   * @param {object} options.run - Current ExecutionRun
   * @param {object} [options.plan] - SupervisorPlan for budget info
   * @param {object[]} [options.recentCheckpoints] - Recent checkpoint history
   * @returns {{ action: string, reason: string }}
   */
  function decideNextAction({ verdict, run, plan = null, recentCheckpoints = [] } = {}) {
    if (!verdict) throw new SupervisorPolicyError("verdict is required");

    const supervision = run.supervision || {};
    const autonomyBudget = plan?.autonomy_budget || {};
    const maxCorrections = autonomyBudget.max_corrections ?? 5;
    const maxAttempts = autonomyBudget.max_attempts ?? 3;

    switch (verdict) {
      case "accepted":
        return { action: "continue_codex", reason: "Evidence acceptable, continue" };

      case "repair_needed": {
        const correctionsUsed = supervision.correction_cycles || 0;
        if (correctionsUsed >= maxCorrections) {
          return { action: "chatgpt_takeover", reason: `Correction budget exhausted (${correctionsUsed}/${maxCorrections})` };
        }
        const sameFailureCount = recentCheckpoints.filter(
          (cp) => cp.verdict === "repair_needed" && cp.trigger_source === run.supervision?.last_failure_signature
        ).length;
        if (sameFailureCount >= 2) {
          return { action: "chatgpt_takeover", reason: `Same failure repeated ${sameFailureCount} times` };
        }
        return { action: "send_correction", reason: `Repair needed (correction ${correctionsUsed + 1}/${maxCorrections})` };
      }

      case "review_needed":
        return { action: "wait_for_chatgpt", reason: "Human review needed for evidence" };

      case "takeover": {
        const takeoverCount = supervision.chatgpt_takeover_count || 0;
        if (takeoverCount >= maxAttempts) {
          return { action: "evaluate_terminal", reason: `Max takeover attempts reached (${takeoverCount}/${maxAttempts})` };
        }
        return { action: "chatgpt_takeover", reason: "Takeover required by checkpoint verdict" };
      }

      case "terminal":
        return { action: "evaluate_terminal", reason: "Run is terminal, evaluate completion" };

      default:
        return { action: "wait_for_chatgpt", reason: `Unknown verdict: ${verdict}` };
    }
  }

  /**
   * Determine if a checkpoint should be created based on trigger source and run state.
   *
   * @param {object} options
   * @param {string} options.triggerSource
   * @param {object} options.run
   * @param {object} [options.plan]
   * @returns {boolean}
   */
  function shouldCheckpoint({ triggerSource, run, plan = null } = {}) {
    const policy = plan?.checkpoint_policy || {};
    const triggers = policy.triggers || ["no_progress"];

    // Always checkpoint for terminal events
    if (["evidence_ready", "startup"].includes(triggerSource)) return true;

    // Check if this trigger is enabled
    if (!triggers.includes(triggerSource)) return false;

    // Rate limit based on existing checkpoints
    if (run.checkpoint_ids?.length >= 50) return false;

    return true;
  }

  return { decideNextAction, shouldCheckpoint };
}
