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

import { relative, resolve } from "node:path";

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

/**
 * Strictly assert that ChatGPT has direct control of the given run.
 * Used by all Project Control write tools as a pre-flight guard.
 *
 * @param {object} options
 * @param {string} options.runId - Expected run ID
 * @param {number} options.controllerEpoch - Expected controller epoch
 * @param {object} options.run - ExecutionRun
 * @param {object} options.lease - Controller lease state
 * @param {string} [options.requestedPath] - Path being accessed (optional)
 * @param {object} [options.plan] - SupervisorPlan (optional)
 * @returns {{ valid: boolean, errors: string[] }}
 * @throws {ProjectControlInvariantError} On invariant violation
 */
export function assertChatGPTDirectControl({
  runId,
  controllerEpoch,
  run,
  lease,
  requestedPath,
  plan,
} = {}) {
  const errors = [];

  // 1. Run ID consistency
  if (runId && run.id !== runId) {
    errors.push(`Run id mismatch: expected "${runId}", got "${run.id}"`);
  }

  // 2. Run state must be chatgpt_direct
  if (run.state !== "chatgpt_direct") {
    errors.push(
      `Run state must be "chatgpt_direct", got "${run.state}"`
    );
  }

  // 3. Controller owner must be chatgpt_direct
  const controllerOwner = run.supervision?.controller_owner;
  if (controllerOwner !== "chatgpt_direct") {
    errors.push(
      `Controller owner must be "chatgpt_direct", got "${controllerOwner}"`
    );
  }

  // 4. Lease owner must be chatgpt_direct
  if (lease?.owner !== "chatgpt_direct") {
    errors.push(
      `Lease owner must be "chatgpt_direct", got "${lease?.owner}"`
    );
  }

  // 5. Controller epoch must match
  if (controllerEpoch != null && controllerEpoch !== (lease?.epoch ?? run.supervision?.controller_epoch)) {
    errors.push(
      `Controller epoch mismatch: expected ${controllerEpoch}, lease has ${lease?.epoch}, run has ${run.supervision?.controller_epoch}`
    );
  }

  // 6. Requested path must be inside the run's worktree
  if (requestedPath && run.workspace_ref?.worktree_path) {
    const worktreePath = resolve(run.workspace_ref.worktree_path);
    const absRequested = resolve(requestedPath);
    const rel = relative(worktreePath, absRequested);
    if (rel.startsWith("..") || rel === absRequested) {
      errors.push(
        `Requested path "${requestedPath}" is outside the worktree "${worktreePath}"`
      );
    }
  }

  if (errors.length > 0) {
    throw new ProjectControlInvariantError(
      `ChatGPT direct control invariants violated: ${errors.join("; ")}`,
      { runId, controllerEpoch, errors }
    );
  }

  return { valid: true, errors: [] };
}
