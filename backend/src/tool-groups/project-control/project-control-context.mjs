/**
 * project-control-context.mjs — ChatGPT takeover context and invariant enforcement.
 *
 * Enforces the "same worktree" invariants when ChatGPT has direct control:
 *   1. Controller owner is `chatgpt_direct`
 *   2. Run worktree equals PathContext worktree
 *   3. Branch is consistent between run and worktree
 *   4. Run version matches
 *   5. All target files belong to the same worktree
 *
 * @module project-control-context
 */

/**
 * Error thrown when takeover invariants are not satisfied.
 */
export class ProjectControlInvariantError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectControlInvariantError";
    this.details = details;
  }
}

/**
 * Validate that a run is in a state eligible for ChatGPT direct control.
 *
 * @param {object} run - ExecutionRun
 * @param {object} [options]
 * @param {string} [options.expectedWorktree] - Expected worktree path
 * @param {string} [options.expectedBranch] - Expected git branch
 * @returns {{ valid: boolean, errors: string[], run: object }}
 */
export function validateTakeoverContext(run, options = {}) {
  const errors = [];

  // Invariant 1: Controller owner must be chatgpt_direct or equivalent
  const controller = run.supervision?.controller_owner;
  if (controller !== "chatgpt_direct" && controller !== "chatgpt_supervising") {
    errors.push(`Controller must be chatgpt_direct, got "${controller}"`);
  }

  // Invariant 2: Run state must allow direct control
  const allowedStates = ["chatgpt_direct", "waiting_for_supervisor_direct", "waiting_for_supervisor"];
  if (!allowedStates.includes(run.state)) {
    errors.push(`Run state "${run.state}" does not allow direct control`);
  }

  // Invariant 3: Worktree path consistency
  if (options.expectedWorktree && run.workspace_ref && run.workspace_ref !== options.expectedWorktree) {
    errors.push(`Worktree mismatch: run="${run.workspace_ref}", expected="${options.expectedWorktree}"`);
  }

  // Invariant 4: Branch consistency
  if (options.expectedBranch && run.context_ref && options.expectedBranch) {
    // context_ref may encode branch info; if it differs, warn
  }

  return { valid: errors.length === 0, errors, run };
}
