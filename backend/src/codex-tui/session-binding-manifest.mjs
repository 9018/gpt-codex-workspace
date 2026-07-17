/**
 * session-binding-manifest.mjs — Session Binding Manifest schema and validation.
 *
 * A Session Binding records the linkage between an ExecutionRun attempt
 * and the control session (PTY) + native Codex session that serves it.
 * This binding is the durable proof that the right session is serving
 * the right run in the right worktree.
 *
 * @module codex-tui/session-binding-manifest
 */

/**
 * Create a session binding manifest.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.attemptId
 * @param {string} [input.taskId]
 * @param {string} [input.goalId]
 * @param {string} input.worktreePath
 * @param {string} input.controlSessionId
 * @param {string} [input.nativeSessionId]
 * @param {string} [input.resumeToken]
 * @param {string} [input.codexHome]
 * @returns {object} Session binding
 */
export function createSessionBinding({
  runId,
  attemptId,
  taskId = null,
  goalId = null,
  worktreePath,
  controlSessionId,
  nativeSessionId = null,
  resumeToken = null,
  codexHome = null,
} = {}) {
  if (!runId) throw new Error("runId is required");
  if (!attemptId) throw new Error("attemptId is required");
  if (!worktreePath) throw new Error("worktreePath is required");
  if (!controlSessionId) throw new Error("controlSessionId is required");

  const now = new Date().toISOString();

  return {
    run_id: runId,
    attempt_id: attemptId,
    task_id: taskId,
    goal_id: goalId,
    worktree_path: worktreePath,
    control_session_id: controlSessionId,
    native_session_id: nativeSessionId,
    resume_token: resumeToken,
    codex_home: codexHome,
    started_at: now,
    last_bound_at: now,
  };
}

/**
 * Validate that a session binding matches the expected run.
 * Compares paths by their resolved form if available, falling back
 * to direct string comparison.
 *
 * @param {object} options
 * @param {object} options.binding - Session binding manifest
 * @param {object} options.run - ExecutionRun
 * @throws {Error} On binding mismatch
 */
export function assertSessionBinding({ binding, run } = {}) {
  if (!binding) throw new Error("binding is required");
  if (!run) throw new Error("run is required");

  if (binding.run_id !== run.id) {
    throw new Error(
      `Session binding run_id mismatch: binding has "${binding.run_id}", run has "${run.id}"`
    );
  }

  // Compare worktree paths (resolve symlinks when possible)
  const bindingPath = binding.worktree_path || "";
  const runPath = run.workspace_ref?.worktree_path || "";
  if (bindingPath && runPath) {
    try {
      const { realpathSync } = require ? require("node:fs") : { realpathSync: (p) => p };
      const resolvedBinding = realpathSync ? realpathSync(bindingPath) : bindingPath;
      const resolvedRun = realpathSync ? realpathSync(runPath) : runPath;
      if (resolvedBinding !== resolvedRun) {
        throw new Error(
          `Session binding worktree mismatch: binding at "${resolvedBinding}", run at "${resolvedRun}"`
        );
      }
    } catch {
      // If realpath fails (path doesn't exist), fall back to string comparison
      if (bindingPath !== runPath) {
        throw new Error(
          `Session binding worktree mismatch: binding "${bindingPath}", run "${runPath}"`
        );
      }
    }
  }

  if (binding.attempt_id !== run.active_attempt_id) {
    throw new Error(
      `Session binding attempt_id mismatch: binding has "${binding.attempt_id}", run has "${run.active_attempt_id}"`
    );
  }
}
