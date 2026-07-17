/**
 * supervisor-action-guard.mjs — Pre-flight validation for SupervisorCommands.
 *
 * Validates that a command can be safely executed given the current
 * run state, controller lease, revision, and autonomy budget.
 * Returns { valid, errors } — never throws.
 *
 * @module supervisor-review/supervisor-action-guard
 */

/** Actions that require an active, writable TUI session. */
const ACTIONS_REQUIRING_TUI = new Set([
  "send_correction",
  "pause_codex",
]);

/** States in which execution actions are allowed. */
const EXECUTION_ALLOWED_STATES = new Set([
  "running",
  "collecting",
  "evaluating",
  "correcting",
  "resuming",
  "waiting_for_repair",
]);

/** Actions that require acceptance checking. */
const ACTIONS_REQUIRING_ACCEPTANCE = new Set([
  "evaluate_terminal",
]);

/**
 * Create the action guard.
 *
 * @returns {object} { validateCommand }
 */
export function createActionGuard() {
  /**
   * Validate a command before execution.
   *
   * @param {object} options
   * @param {object} options.command - SupervisorCommand
   * @param {object} options.run - ExecutionRun
   * @param {object} options.lease - Controller lease
   * @param {object} options.currentRevision - Current ReviewRevision
   * @param {object} [options.plan] - SupervisorPlan (for budget)
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validateCommand({ command: cmd, run, lease, currentRevision, plan = {} }) {
    const errors = [];

    // 1. Revision check
    if (cmd.review_revision_id !== currentRevision.id) {
      errors.push(
        `Stale revision: command expects ${cmd.review_revision_id}, current is ${currentRevision.id}`
      );
    }

    // 2. Run version check
    const expectedVersion = cmd.preconditions?.expected_run_version;
    if (expectedVersion != null && expectedVersion > run.version) {
      errors.push(
        `Run version mismatch: command expects ${expectedVersion}, run is ${run.version}`
      );
    }

    // 3. Controller ownership check (against authoritative lease)
    const expectedOwner = cmd.preconditions?.expected_controller_owner;
    if (expectedOwner && expectedOwner !== lease.owner) {
      errors.push(
        `Controller owner mismatch: command expects ${expectedOwner}, lease has ${lease.owner}`
      );
    }

    // 4. Budget check
    const budget = plan.autonomy_budget || {};
    const maxCorrections = budget.max_corrections ?? 5;
    const correctionsUsed = run.supervision?.correction_cycles || 0;
    if (cmd.action === "send_correction" && correctionsUsed >= maxCorrections) {
      errors.push(
        `Correction budget exhausted: ${correctionsUsed}/${maxCorrections}`
      );
    }

    // 5. Run state compatibility
    if (ACTIONS_REQUIRING_TUI.has(cmd.action)) {
      if (!EXECUTION_ALLOWED_STATES.has(run.state)) {
        errors.push(
          `Action ${cmd.action} not allowed in run state ${run.state}`
        );
      }
    }

    // 6. Terminal state check  
    if (["completed", "failed", "cancelled"].includes(run.state)) {
      errors.push(`Run is in terminal state: ${run.state}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  return { validateCommand };
}
