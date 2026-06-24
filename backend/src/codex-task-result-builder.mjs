import { KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT } from "./codex-finalizer-contract.mjs";

/** Max chars of raw output to include in no-op diagnostics. */
const DIAGNOSTIC_EXCERPT_MAX = 2000;

function acceptanceFields(parsed = {}) {
  return {
    reviewer_decision: parsed.reviewer_decision || null,
    acceptance_findings: Array.isArray(parsed.acceptance_findings) ? parsed.acceptance_findings : [],
    next_tasks: Array.isArray(parsed.next_tasks) ? parsed.next_tasks : [],
  };
}

/**
 * Build a standardized task result from parsed Codex output.
 *
 * @param {object} parsed - Parsed result from codex-result-parser.mjs
 * @param {object} [opts]
 * @param {boolean} [opts.timedOut=false]
 * @param {number} [opts.timeoutSeconds=0]
 * @param {number} [opts.returnCode=0]
 * @param {object} [opts.cr] - Raw command result from runLocalShell (for diagnostics)
 * @returns {object} Task result object
 */
export function buildTaskResult(parsed, { timedOut = false, timeoutSeconds = 0, returnCode = 0, cr = null } = {}) {
  const now = new Date().toISOString();

  // Helper to detect no-op completed results
  function _isNoop(p) {
    const noChangedFiles = !Array.isArray(p.changed_files) || p.changed_files.length === 0;
    const noTests = !p.tests || p.tests === "none";
    const noCommit = !p.commit || p.commit === "none";
    const noSummary = !p.summary || p.summary === "No-op: Codex execution completed with no changes" || p.summary.includes("no structured summary");
    return noChangedFiles && noTests && noCommit && noSummary;
  }

  /**
   * Build a detailed diagnostics object when no-op is detected.
   * Includes stdout/stderr excerpts, exit code, timeout info, and parser metadata
   * so the operator can determine why Codex failed to produce meaningful output.
   */
  function _buildNoopDiagnostics(p, cr) {
    const diag = {
      detected_reason: "No changed files, no tests, no commit, no structured summary",
      result_json_path: p._result_json_path || null,
      result_json_error: p._result_json_error || (p._result_json_path ? "not found or invalid" : null),
      from_json: p.from_json || false,
      stdout_structured: p.structured || false,
      exit_code: cr?.returncode ?? returnCode,
      timed_out: cr?.timed_out || timedOut || false,
      no_first_output_timeout: cr?.no_first_output_timeout || false,
      stdout_bytes: cr?.stdout_bytes ?? 0,
      stderr_bytes: cr?.stderr_bytes ?? 0,
      raw_stdout_first: null,
      raw_stdout_last: null,
      raw_stderr_excerpt: null,
    };

    if (cr?.stdout && typeof cr.stdout === "string") {
      const s = cr.stdout;
      diag.raw_stdout_first = s.slice(0, DIAGNOSTIC_EXCERPT_MAX);
      if (s.length > DIAGNOSTIC_EXCERPT_MAX) {
        diag.raw_stdout_last = s.slice(-DIAGNOSTIC_EXCERPT_MAX);
      }
    }
    if (cr?.stderr && typeof cr.stderr === "string") {
      const e = cr.stderr;
      diag.raw_stderr_excerpt = e.slice(0, DIAGNOSTIC_EXCERPT_MAX);
    }
    if (cr?.returncode != null) diag.exit_code = cr.returncode;
    if (cr?.first_stdout_at) diag.first_stdout_at = cr.first_stdout_at;
    if (cr?.first_stderr_at) diag.first_stderr_at = cr.first_stderr_at;
    if (cr?.first_output_delay_ms != null) diag.first_output_delay_ms = cr.first_output_delay_ms;
    return diag;
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
      ...acceptanceFields(parsed),
      diagnostics: cr ? _buildNoopDiagnostics(parsed, cr) : undefined,
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
      ...acceptanceFields(parsed),
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
        "NO-OP: Codex execution completed with no changed files, no tests, no commit, and no structured summary. " +
        "Root causes may include: (a) model provider returned empty or non-actionable response, " +
        "(b) prompt was too large for context window, (c) codex exec timed out before model responded, " +
        "(d) stdout/stderr was truncated or not captured. " +
        "See the 'diagnostics' field for detailed execution metadata. " +
        "This task completed with no changes (no-op). See diagnostics for details."
      );
    }
    return {
      kind: isNoop ? "noop" : KIND_EXECUTED,
      summary: isNoop
        ? "NO-OP: Codex execution completed with no changes. See diagnostics for details."
        : (parsed.summary || "Codex execution completed (no structured summary)"),
      diagnostics: isNoop && cr ? _buildNoopDiagnostics(parsed, cr) : undefined,
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings,
      followups: parsed.followups || [],
      ...acceptanceFields(parsed),
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
      ...acceptanceFields(parsed),
      diagnostics: cr ? _buildNoopDiagnostics(parsed, cr) : undefined,
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
      diagnostics: cr ? _buildNoopDiagnostics(parsed, cr) : undefined,
      completed_at: now,
      timed_out: false,
    };
  }

  // Fallback: executed but no structured STATUS
  const isNoop = _isNoop(parsed);
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (isNoop) {
    warnings.push(
      "NO-OP: Codex execution completed with no changed files, no tests, no commit, and no structured summary. " +
      "See the 'diagnostics' field for detailed execution metadata. " +
      "This task completed with no changes (no-op). See diagnostics for details."
    );
  }
  return {
    kind: isNoop ? "noop" : KIND_EXECUTED,
    summary: isNoop
      ? "NO-OP: Codex execution completed with no changes. See diagnostics for details."
      : (parsed.summary || "Codex execution completed (no structured summary)"),
    diagnostics: isNoop && cr ? _buildNoopDiagnostics(parsed, cr) : undefined,
    structured: parsed.structured,
    from_json: parsed.from_json,
    changed_files: parsed.changed_files || [],
    tests: parsed.tests,
    commit: parsed.commit,
    remote_head: parsed.remote_head,
    warnings,
    followups: parsed.followups || [],
    ...acceptanceFields(parsed),
    completed_at: now,
    noop: isNoop || undefined,
  };
}
