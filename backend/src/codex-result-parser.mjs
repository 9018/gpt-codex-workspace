/**
 * Codex result parser - extracts structured fields from Codex CLI output.
 *
 * Codex is instructed to emit a structured report with these fields:
 *   STATUS=<completed|failed|timed_out>
 *   SUMMARY=<one line>
 *   CHANGED_FILES=<comma separated or none>
 *   TESTS=<commands and pass/fail or none>
 *   COMMIT=<sha or none>
 *   REMOTE_HEAD=<sha or none>
 *
 * This parser extracts those fields and normalizes them into a consistent object.
 */

/**
 * Parse the structured report from Codex output.
 *
 * @param {string} output - The raw output from Codex CLI execution.
 * @returns {object} Parsed result with:
 *   - status: "completed" | "failed" | "timed_out" | null
 *   - summary: string or null
 *   - changed_files: string[] (empty if none)
 *   - tests: string or null
 *   - commit: string or null
 *   - remote_head: string or null
 *   - structured: boolean - true if any structured fields were found
 *   - raw_summary_excerpt: first 500 chars of raw output for diagnostics
 */
export function parseCodexResult(output) {
  if (!output || typeof output !== "string") {
    return {
      status: null,
      summary: null,
      changed_files: [],
      tests: null,
      commit: null,
      remote_head: null,
      structured: false,
      raw_summary_excerpt: null
    };
  }

  const lines = output.split("\n");
  let structured = false;
  let status = null;
  let summary = null;
  let changedFilesRaw = null;
  let tests = null;
  let commit = null;
  let remoteHead = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // STATUS=<completed|failed|timed_out>
    const statusMatch = trimmed.match(/^STATUS=(completed|failed|timed_out)$/i);
    if (statusMatch) {
      status = statusMatch[1].toLowerCase();
      structured = true;
      continue;
    }

    // SUMMARY=<one line>
    const summaryMatch = trimmed.match(/^SUMMARY=(.*)$/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // CHANGED_FILES=<comma separated or none>
    const filesMatch = trimmed.match(/^CHANGED_FILES=(.*)$/i);
    if (filesMatch) {
      changedFilesRaw = filesMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // TESTS=<commands and pass/fail or none>
    const testsMatch = trimmed.match(/^TESTS=(.*)$/i);
    if (testsMatch) {
      tests = testsMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // COMMIT=<sha or none>
    const commitMatch = trimmed.match(/^COMMIT=(.*)$/i);
    if (commitMatch) {
      commit = commitMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // REMOTE_HEAD=<sha or none>
    const remoteMatch = trimmed.match(/^REMOTE_HEAD=(.*)$/i);
    if (remoteMatch) {
      remoteHead = remoteMatch[1].trim() || null;
      structured = true;
      continue;
    }
  }

  // Normalize changed_files
  let changedFiles = [];
  if (changedFilesRaw && changedFilesRaw.toLowerCase() !== "none") {
    changedFiles = changedFilesRaw.split(",").map(f => f.trim()).filter(Boolean);
  }

  // Normalize "none" values
  if (status && status === "none") status = null;
  if (summary && summary.toLowerCase() === "none") summary = null;
  if (tests && tests.toLowerCase() === "none") tests = null;
  if (commit && commit.toLowerCase() === "none") commit = null;
  if (remoteHead && remoteHead.toLowerCase() === "none") remoteHead = null;

  return {
    status,
    summary,
    changed_files: changedFiles,
    tests,
    commit,
    remote_head: remoteHead,
    structured,
    raw_summary_excerpt: output.slice(0, 500)
  };
}

/**
 * Build a task.result object from parsed Codex output for successful execution.
 *
 * @param {object} parsed - Result from parseCodexResult()
 * @param {object} options
 * @param {boolean} options.timedOut - Whether the process timed out
 * @param {number} options.timeoutSeconds - Timeout duration in seconds
 * @returns {object} Task result object
 */
export function buildTaskResult(parsed, { timedOut = false, timeoutSeconds = 0 } = {}) {
  const now = new Date().toISOString();

  if (timedOut) {
    return {
      kind: "codex_timeout",
      summary: parsed.summary || "Codex execution timed out",
      timed_out: true,
      timeout_seconds: timeoutSeconds,
      completed_at: now
    };
  }

  // If STATUS=failed (structured failure, not timeout)
  if (parsed.status === "failed") {
    return {
      kind: "codex_failed",
      summary: parsed.summary || "Codex execution reported failure",
      structured: parsed.structured,
      changed_files: parsed.changed_files,
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      completed_at: now,
      timed_out: false
    };
  }

  // If STATUS=completed (success)
  if (parsed.status === "completed") {
    return {
      kind: "codex_executed",
      summary: parsed.summary || "Codex execution completed (no structured summary)",
      structured: parsed.structured,
      changed_files: parsed.changed_files,
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      completed_at: now
    };
  }

  // If no structured STATUS field was found, treat as failed
  return {
    kind: "codex_failed",
    summary: parsed.summary || "Codex execution failed (no structured status)",
    structured: parsed.structured,
    changed_files: parsed.changed_files,
    tests: parsed.tests,
    commit: parsed.commit,
    remote_head: parsed.remote_head,
    completed_at: now,
    timed_out: false
  };
}
