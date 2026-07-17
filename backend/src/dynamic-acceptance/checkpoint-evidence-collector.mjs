/**
 * checkpoint-evidence-collector.mjs — Collect evidence at checkpoint time.
 *
 * Captures a point-in-time snapshot of the TUI session state,
 * repository state, and test results.
 *
 * @module checkpoint-evidence-collector
 */

/**
 * Create the checkpoint evidence collector.
 *
 * @param {object} deps
 * @param {Function} [deps.readSession] - Read the TUI session record
 * @param {Function} [deps.readResult] - Read a result.json path
 * @param {Function} [deps.getGitDiff] - Get git diff summary
 * @param {Function} [deps.getTranscript] - Get recent TUI transcript
 * @returns {object} Evidence collector API
 */
export function createCheckpointEvidenceCollector(deps = {}) {
  /**
   * Collect evidence at the current checkpoint moment.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {string} [options.sessionId]
   * @param {string} [options.workspaceRoot]
   * @param {object} [options.progressSnapshot] - Current progress tracker state
   * @returns {Promise<object>} Evidence snapshot
   */
  async function collect({ runId, sessionId = null, workspaceRoot = null, progressSnapshot = null } = {}) {
    const evidence = {
      collected_at: new Date().toISOString(),
      run_id: runId,
      session_id: sessionId || null,
      progress: progressSnapshot ? structuredClone(progressSnapshot) : null,
      session: null,
      git_diff: null,
      test_results: null,
      transcript_snippet: null,
    };

    // Session state
    if (sessionId && deps.readSession) {
      try {
        const session = await deps.readSession(sessionId);
        evidence.session = {
          status: session.status,
          last_output_at: session.last_output_at,
          last_meaningful_progress_at: session.last_meaningful_progress_at,
        };
      } catch {
        evidence.session = { error: "session_unavailable" };
      }
    }

    // Git diff
    if (workspaceRoot && deps.getGitDiff) {
      try {
        evidence.git_diff = await deps.getGitDiff(workspaceRoot);
      } catch {
        evidence.git_diff = { error: "git_diff_unavailable" };
      }
    }

    // Transcript snippet
    if (sessionId && deps.getTranscript) {
      try {
        evidence.transcript_snippet = await deps.getTranscript(sessionId);
      } catch {
        evidence.transcript_snippet = null;
      }
    }

    return evidence;
  }

  return { collect };
}
