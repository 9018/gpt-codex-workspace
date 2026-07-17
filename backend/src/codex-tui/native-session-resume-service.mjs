/**
 * native-session-resume-service.mjs — Resume a native Codex session.
 *
 * When a session's control channel is lost, this service can resume
 * the native Codex session by spawning a new `codex resume` process
 * and re-binding it to the same ExecutionRun.
 *
 * Flow:
 *   1. Assert no active control session for this run
 *   2. Assert worktree exists and matches expected identity
 *   3. Spawn `codex resume <nativeSessionId>` via PTY manager
 *   4. Create session binding
 *   5. Wait until session is writable
 *   6. Return binding
 *
 * @module codex-tui/native-session-resume-service
 */

/**
 * Create the native session resume service.
 *
 * @param {object} deps
 * @param {object} deps.processGuard - { assertNoActiveControlSession(runId) }
 * @param {object} deps.repositoryGuard - { assertWorktreeExists(path), assertExpectedIdentity({ run, worktreePath }) }
 * @param {object} deps.ptyManager - { spawn({ cwd, env, command, args }) => { id, pid } }
 * @param {object} deps.sessionBinder - { bind({ runId, attemptId, nativeSessionId, controlSessionId, worktreePath }) => binding }
 * @param {object} deps.readyProbe - { waitUntilWritable(controlSessionId) }
 * @returns {object} { resume }
 */
export function createNativeSessionResumeService(deps) {
  async function resume({ run, nativeSessionId, worktreePath }) {
    // 1. No active control session for this run
    await deps.processGuard.assertNoActiveControlSession(run.id);

    // 2. Worktree preconditions
    await deps.repositoryGuard.assertWorktreeExists(worktreePath);
    await deps.repositoryGuard.assertExpectedIdentity({ run, worktreePath });

    // 3. Spawn codex resume
    const control = await deps.ptyManager.spawn({
      cwd: worktreePath,
      env: { CODEX_HOME: run.codex_home || "" },
      command: "codex",
      args: ["resume", nativeSessionId],
    });

    // 4. Bind the session
    const binding = await deps.sessionBinder.bind({
      runId: run.id,
      attemptId: run.active_attempt_id,
      nativeSessionId,
      controlSessionId: control.id,
      worktreePath,
    });

    // 5. Wait until writable
    await deps.readyProbe.waitUntilWritable(control.id);

    return binding;
  }

  return { resume };
}
