/**
 * checkpoint-trigger-policy.mjs — Determines when to trigger a checkpoint.
 *
 * Evaluates the current run state against configured conditions:
 * TUI idle, Git diff, test completion, no progress, time interval.
 *
 * @module checkpoint-trigger-policy
 */

/** @type {string[]} All supported trigger sources. */
export { CHECKPOINT_TRIGGER_SOURCES } from "./checkpoint-verdict-schema.mjs";

/**
 * Create the checkpoint trigger policy engine.
 *
 * @returns {object} Trigger policy API
 */
export function createCheckpointTriggerPolicy() {
  /**
   * Check whether any trigger condition is met.
   *
   * @param {object} options
   * @param {object} options.run - Current ExecutionRun
   * @param {object} [options.plan] - SupervisorPlan with trigger config
   * @param {object} [options.progress] - Progress tracker state
   * @param {string|null} [options.lastCheckpointAt] - ISO timestamp of last checkpoint
   * @param {boolean} [options.hasGitDiff] - Whether git state changed
   * @param {boolean} [options.testJustCompleted] - Whether a test just finished
   * @returns {{ shouldTrigger: boolean, triggerSource: string|null, reason: string }}
   */
  function evaluate({ run, plan = null, progress = null, lastCheckpointAt = null, hasGitDiff = false, testJustCompleted = false } = {}) {
    const policy = plan?.checkpoint_policy || {};
    const triggers = policy.triggers || ["no_progress"];

    // Check each trigger source
    if (triggers.includes("no_progress") && progress?.no_progress) {
      return { shouldTrigger: true, triggerSource: "no_progress", reason: "No progress detected for threshold period" };
    }

    if (triggers.includes("tui_idle") && progress?.idle) {
      return { shouldTrigger: true, triggerSource: "tui_idle", reason: "TUI idle for threshold period" };
    }

    if (triggers.includes("git_diff") && hasGitDiff) {
      return { shouldTrigger: true, triggerSource: "git_diff", reason: "Repository state changed" };
    }

    if (triggers.includes("test_completed") && testJustCompleted) {
      return { shouldTrigger: true, triggerSource: "test_completed", reason: "Test run completed" };
    }

    if (triggers.includes("interval") && lastCheckpointAt) {
      const interval = (policy.interval_seconds || 300) * 1000;
      const elapsed = Date.now() - new Date(lastCheckpointAt).getTime();
      if (elapsed >= interval) {
        return { shouldTrigger: true, triggerSource: "interval", reason: `Checkpoint interval exceeded (${Math.round(elapsed / 1000)}s > ${interval / 1000}s)` };
      }
    }

    return { shouldTrigger: false, triggerSource: null, reason: "No trigger conditions met" };
  }

  return { evaluate };
}
