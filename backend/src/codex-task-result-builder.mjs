import { KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT } from "./codex-finalizer-contract.mjs";

/**
 * Build a standardized task result from parsed Codex output.
 *
 * @param {object} parsed - Parsed result from codex-result-parser.mjs
 * @param {object} [opts]
 * @param {boolean} [opts.timedOut=false]
 * @param {number} [opts.timeoutSeconds=0]
 * @param {number} [opts.returnCode=0]
 * @returns {object} Task result object
 */
export function buildTaskResult(parsed, { timedOut = false, timeoutSeconds = 0, returnCode = 0 } = {}) {
  const now = new Date().toISOString();

  // Helper to detect no-op completed results
  function _isNoop(p) {
    const noChangedFiles = !Array.isArray(p.changed_files) || p.changed_files.length === 0;
    const noTests = !p.tests || p.tests === "none";
    const noCommit = !p.commit || p.commit === "none";
    const noSummary = !p.summary || p.summary.includes("no structured summary");
    return noChangedFiles && noTests && noCommit && noSummary;
  }

  if (timedOut) {
    return {
      kind: KIND_TIMEOUT,
      summary: parsed.summary || "Codex execution timed out",
      timed_out: true,
      timeout_seconds: timeoutSeconds,
      changed_files: parsed.changed_files || [],
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
    };
  }

  // If STATUS=failed (structured failure, not timeout)
  if (parsed.status === "failed") {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution reported failure",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false,
    };
  }

  // If STATUS=completed (success)
  if (parsed.status === "completed") {
    const isNoop = _isNoop(parsed);
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    if (isNoop) {
      warnings.push(
        "No-op completion detected: no changed files, no tests, no commit, and no structured summary. " +
        "This task produced no meaningful changes. For P0/P0.1 tasks, no-op completion should be " +
        "flagged as failed or waiting_for_review."
      );
    }
    return {
      kind: isNoop ? "noop" : KIND_EXECUTED,
      summary: isNoop ? "No-op: Codex execution completed with no changes" : (parsed.summary || "Codex execution completed (no structured summary)"),
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings,
      followups: parsed.followups || [],
      completed_at: now,
      noop: isNoop || undefined,
    };
  }

  // If STATUS=timed_out but process didn't actually time out, treat as failed
  if (parsed.status === "timed_out") {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution reported timeout (no process timeout)",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false,
    };
  }

  // If no structured STATUS field was found, use exit code to decide
  if (returnCode !== 0) {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution failed (non-zero exit)",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false,
    };
  }

  // Fallback: executed but no structured STATUS
  const isNoop = _isNoop(parsed);
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (isNoop) {
    warnings.push(
      "No-op completion detected: no changed files, no tests, no commit, and no structured summary. " +
      "This task produced no meaningful changes."
    );
  }
  return {
    kind: isNoop ? "noop" : KIND_EXECUTED,
    summary: isNoop ? "No-op: Codex execution completed with no changes" : (parsed.summary || "Codex execution completed (no structured summary)"),
    structured: parsed.structured,
    from_json: parsed.from_json,
    changed_files: parsed.changed_files || [],
    tests: parsed.tests,
    commit: parsed.commit,
    remote_head: parsed.remote_head,
    warnings,
    followups: parsed.followups || [],
    completed_at: now,
    noop: isNoop || undefined,
  };
}
