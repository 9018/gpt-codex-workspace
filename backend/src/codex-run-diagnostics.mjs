/**
 * codex-run-diagnostics.mjs — structured classification of Codex runner failures.
 *
 * Provides stable classification for stdout=0, result.json missing, stderr with
 * signals such as 429/rate-limit, model startup failures, and other failure
 * modes encountered during Codex CLI execution.
 * P0-07: Extended with explicit no_first_output_timeout and codex_timeout
 * classifications so these production paths have well-defined next_actions.
 *
 * Exports (P0-07):
 *   classifyRunFailure(input)    — classify a runner execution result
 *   QUOTA_PATTERNS               — regex patterns for quota/rate-limit detection
 *   PROMPT_LENGTH_THRESHOLD      — threshold for needs_task_splitting
 *
 * Classification values (failure_class):
 *   quota_exhausted_or_rate_limited
 *   model_or_provider_startup_failure
 *   no_result_json_no_changes
 *   no_result_json_with_git_changes
 *   no_result_json_with_commit
 *   needs_task_splitting
 *   no_first_output_timeout      (P0-07)
 *   codex_timeout                (P0-07)
 *   codex_failed (fallback)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex patterns that signal quota exhaustion or rate limiting. */
export const QUOTA_PATTERNS = [
  /\b429\b/,
  /rate\s*limit/i,
  /quota/i,
  /insufficient_quota/i,
  /billing/i,
  /capacity/i,
  /too\s*many\s*requests/i,
  /request\s*limit/i,
  /exceeded\s*(?:your\s*)?(?:current\s*)?(?:rate|quota)/i,
  /(?:api|request)_rate_limit/i,
  /capacity\s*exceeded/i,
  /resource\s*exhausted/i,
];

/** Regex patterns that indicate Codex CLI header output (model/provider info). */
const CODEX_CLI_HEADER_PATTERNS = [
  /codex\s*(?:cli)?\s*(?:version|v\d+)/i,
  /model:/i,
  /provider:/i,
  /reasoning\s*effort:/i,
  /using\s+(?:model|provider)/i,
  /running\s+(?:codex|agent)/i,
];

/** Threshold (in characters) for prompt/context length that suggests needs_task_splitting. */
export const PROMPT_LENGTH_THRESHOLD = 120_000;

/** Default maximum stderr tail characters in diagnostics output. */
const STDERR_TAIL_MAX = 2000;

// ---------------------------------------------------------------------------
// Helper: check if combined output matches any of the quota patterns
// ---------------------------------------------------------------------------

function _matchesQuotaPattern(text) {
  if (!text) return false;
  for (const re of QUOTA_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: detect Codex CLI header in output
// ---------------------------------------------------------------------------

function _hasCodexCliHeader(text) {
  if (!text) return false;
  for (const re of CODEX_CLI_HEADER_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: extract model/provider/reasoning effort from header text
// ---------------------------------------------------------------------------

function _extractHeaderMetadata(text) {
  const result = { model: null, provider: null, reasoning_effort: null };
  if (!text) return result;
  for (const line of text.split("\n")) {
    const ll = line.toLowerCase();
    if (!result.model && ll.includes("model:")) {
      const m = line.match(/model:\s*(.+)/i);
      if (m) result.model = m[1].trim();
    }
    if (!result.provider && (ll.includes("provider:") || ll.includes("api provider:"))) {
      const m = line.match(/(?:api\s+)?provider:\s*(.+)/i);
      if (m) result.provider = m[1].trim();
    }
    if (!result.reasoning_effort && ll.includes("reasoning effort:")) {
      const m = line.match(/reasoning\s+effort:\s*(.+)/i);
      if (m) result.reasoning_effort = m[1].trim();
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main classification function
// ---------------------------------------------------------------------------

/**
 * Classify a Codex runner execution result into a stable failure category.
 *
 * @param {object} input
 * @param {string}  [input.stdout=""|null]        - Full stdout text (or combined stdout+stderr)
 * @param {string}  [input.stderr=""|null]        - Full stderr text
 * @param {number|null} [input.exitCode=null]     - Runner exit code
 * @param {object|null}  [input.resultJson=null]   - Parsed result.json if available
 * @param {boolean} [input.hasResultJson=false]    - True if result.json existed on disk
 * @param {boolean} [input.hasCommit=false]        - True if a commit was created
 * @param {boolean} [input.hasGitChanges=false]    - True if worktree has uncommitted changes
 * @param {string}  [input.model=null]             - Model name if known (overrides extraction)
 * @param {string}  [input.provider=null]          - Provider name if known
 * @param {string}  [input.reasoningEffort=null]   - Reasoning effort if known
 * @param {string}  [input.executionCwd=null]      - Working directory during execution
 * @param {string}  [input.resultJsonPath=null]    - Path to expected result.json
 * @param {number}  [input.promptLength=0]         - Prompt character length
 * @param {number}  [input.contextLength=0]        - Context/token length estimate
 * @param {string}  [input.outputSummary=null]     - Any structured summary from stdout
 * @param {boolean} [input.timedOut=false]         - P0-07: Process timed out (no content or total)
 * @param {boolean} [input.noFirstOutputTimeout=false] - P0-07: No first output before timeout
 *
 * @returns {{
 *   failure_class: string,
 *   detected_reason: string,
 *   severity: string,
 *   operator_action: string,
 *   creates_repair_task: boolean,
 *   creates_retry_followup: boolean,
 *   creates_delivery_recovery: boolean,  (P0-07)
 *   can_auto_retry: boolean,             (P0-07)
 *   healing_action: string|null,         (P0-07)
 *   review_reason: string|null,          (P0-07)
 *   diagnostics: object
 * }}
 */
export function classifyRunFailure(input = {}) {
  const {
    stdout = "",
    stderr = "",
    exitCode = null,
    resultJson = null,
    hasResultJson = false,
    hasCommit = false,
    hasGitChanges = false,
    model: explicitModel = null,
    provider: explicitProvider = null,
    reasoningEffort: explicitReasoning = null,
    executionCwd = null,
    resultJsonPath = null,
    promptLength = 0,
    contextLength = 0,
    outputSummary = null,
    timedOut = false,
    noFirstOutputTimeout = false,
  } = input;

  const stdoutText = String(stdout || "");
  const stderrText = String(stderr || "");
  const combinedText = stdoutText + "\n" + stderrText;

  const hasStdout = stdoutText.trim().length > 0;
  const hasStderr = stderrText.trim().length > 0;

  const diagnostics = {
    exit_code: exitCode,
    has_stdout: hasStdout,
    has_stderr: hasStderr,
    has_result_json: hasResultJson,
    has_commit: hasCommit,
    has_git_changes: hasGitChanges,
    execution_cwd: executionCwd || null,
    result_json_path: resultJsonPath || null,
    timed_out: timedOut,
    no_first_output_timeout: noFirstOutputTimeout,
  };


  // -----------------------------------------------------------------------
  // P0-07: no_first_output_timeout — Codex CLI started but produced no
  // output before the first-output timeout.  This is an infra/resource
  // issue (model cold-start, network, quota), NOT a code defect.
  // -----------------------------------------------------------------------
  if (noFirstOutputTimeout) {
    return {
      failure_class: "no_first_output_timeout",
      detected_reason: `Codex CLI was invoked but produced no output before the first-output timeout. Possible causes: model cold-start delay, provider overload, network latency, or quota exhaustion at startup. The task produced no result.json and no commit.`,
      severity: "recoverable",
      operator_action: "Retry with compacted context bundle to reduce model startup time. " +
        "If the problem persists, check provider status and API key validity. " +
        "This is an infra/resource issue — no code changes needed.",
      creates_repair_task: false,
      creates_retry_followup: true,
      can_auto_retry: true,
      healing_action: "compact_and_retry",
      creates_delivery_recovery: false,
      review_reason: null,
      diagnostics,
    };
  }

  // -----------------------------------------------------------------------
  // P0-07: codex_timeout — The process ran past the total exec timeout.
  // The model may have returned partial results but was cut off before
  // completing.  Check for partial commit/worktree evidence.
  // -----------------------------------------------------------------------
  if (timedOut) {
    const hasPartialEvidence = hasCommit || hasGitChanges || hasStdout;
    return {
      failure_class: "codex_timeout",
      detected_reason: `Codex CLI execution timed out after the configured timeout.` +
        (hasPartialEvidence
          ? ` Partial evidence detected: commit=${hasCommit}, git_changes=${hasGitChanges}, stdout=${hasStdout}. Consider recovering partial work.`
          : ` No partial evidence was produced. The model may not have started responding before the timeout.`),
      severity: hasPartialEvidence ? "recoverable" : "failed",
      operator_action: hasPartialEvidence
        ? "Recover partial work from the worktree and retry. Preserve any uncommitted changes before retrying."
        : "Retry with compacted context bundle or increased timeout. If the problem persists, check model/provider capacity.",
      creates_repair_task: false,
      creates_retry_followup: true,
      can_auto_retry: true,
      healing_action: "compact_and_retry",
      creates_delivery_recovery: hasPartialEvidence,
      review_reason: hasPartialEvidence ? "codex_timeout_with_partial_evidence" : null,
      diagnostics,
    };
  }

  const headerMeta = _extractHeaderMetadata(combinedText);
  const model = explicitModel || headerMeta.model || null;
  const provider = explicitProvider || headerMeta.provider || null;
  const reasoningEffort = explicitReasoning || headerMeta.reasoning_effort || null;
  if (model) diagnostics.model = model;
  if (provider) diagnostics.provider = provider;
  if (reasoningEffort) diagnostics.reasoning_effort = reasoningEffort;

  if (hasStderr) {
    diagnostics.stderr_tail = stderrText.slice(-STDERR_TAIL_MAX);
  }

  // -----------------------------------------------------------------------
  // Classification 1: quota_exhausted_or_rate_limited
  // -----------------------------------------------------------------------
  const quotaMatch = _matchesQuotaPattern(combinedText);
  if (quotaMatch) {
    const matched = QUOTA_PATTERNS.find((re) => re.test(combinedText));
    const matchText = matched ? matched.source : "unknown";
    return {
      failure_class: "quota_exhausted_or_rate_limited",
      detected_reason: `Quota/rate-limit signal detected in output (matched pattern: ${matchText}). This is an API/service capacity issue, not a code defect.`,
      severity: "recoverable",
      operator_action: "Wait for quota to recover and retry. No code changes needed. If rate-limited, wait for the reset window and retry.",
      creates_repair_task: false,
      creates_retry_followup: true,
      diagnostics,
    };
  }

  // -----------------------------------------------------------------------
  // Classification 2: model_or_provider_startup_failure
  // -----------------------------------------------------------------------
  const hasCliHeader = _hasCodexCliHeader(combinedText);

  if (hasCliHeader && !quotaMatch && !hasResultJson && exitCode !== 0 && exitCode !== null) {
    return {
      failure_class: "model_or_provider_startup_failure",
      detected_reason: `Codex CLI header detected (model=${model || "unknown"}, provider=${provider || "unknown"}) but runner exited with code ${exitCode} and no result.json was produced. This is a startup/configuration failure, not a code defect.`,
      severity: "operator_action_required",
      operator_action: "Check provider/model configuration, API keys, and authentication. The model or provider failed to start correctly. No code changes needed.",
      creates_repair_task: false,
      creates_retry_followup: true,
      diagnostics,
    };
  }

  // -----------------------------------------------------------------------
  // Classification 3: needs_task_splitting
  // -----------------------------------------------------------------------
  const combinedLength = promptLength || contextLength || 0;
  if (combinedLength > PROMPT_LENGTH_THRESHOLD && !hasResultJson && !hasCommit) {
    return {
      failure_class: "needs_task_splitting",
      detected_reason: `Prompt/context length (${combinedLength} chars) exceeds the threshold (${PROMPT_LENGTH_THRESHOLD} chars). The task may be too large for a single Codex run.`,
      severity: "warning",
      operator_action: "Split the task into smaller sub-tasks. Consider breaking the work into independent, focused goals. No code changes needed.",
      creates_repair_task: false,
      creates_retry_followup: false,
      diagnostics: {
        ...diagnostics,
        prompt_length: promptLength,
        context_length: contextLength,
        threshold: PROMPT_LENGTH_THRESHOLD,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Missing result.json cases
  // -----------------------------------------------------------------------
  if (!hasResultJson || !resultJson) {
    if (hasCommit) {
      return {
        failure_class: "no_result_json_with_commit",
        detected_reason: "No result.json was found, but a commit exists. The commit can serve as acceptance evidence.",
        severity: "recoverable",
        operator_action: "Use the commit as acceptance evidence. Consider creating synthetic result.json from commit metadata and worktree state. Preserve the worktree and branch.",
        creates_repair_task: false,
        creates_retry_followup: false,
        diagnostics,
      };
    }

    if (hasGitChanges) {
      return {
        failure_class: "no_result_json_with_git_changes",
        detected_reason: "No result.json was found, but the worktree has uncommitted changes. The changes should be preserved.",
        severity: "recoverable",
        operator_action: "Preserve the worktree changes and attempt synthetic evidence generation. Do not discard the worktree. Consider creating a commit from the changes.",
        creates_repair_task: false,
        creates_retry_followup: false,
        diagnostics,
      };
    }

    if ((hasStdout || hasStderr) && !hasCommit && !hasGitChanges && exitCode === 0) {
      return {
        failure_class: "result_missing",
        detected_reason: "Runner produced no valid result.json, no commit, and no git changes. This is an execution/provider no-result failure, not a repairable code defect.",
        severity: "failed",
        operator_action: "Retry within the execution retry budget or fail/block when exhausted. Do not create a code repair task unless git changes exist.",
        creates_repair_task: false,
        creates_retry_followup: true,
        diagnostics,
      };
    }


    if (!hasStdout && !hasStderr && !hasCommit && !hasGitChanges && exitCode !== null) {
      return {
        failure_class: "no_result_json_no_changes",
        detected_reason: "Runner produced no output, no result.json, no commit, and no git changes. The task may not have started or was killed before producing any work. A non-null exit code indicates the runner did start but produced nothing usable.",
        severity: "failed",
        operator_action: "Investigate runner logs and environment. The task may need to be re-run with more debugging or a different configuration.",
        creates_repair_task: false,
        creates_retry_followup: true,
        diagnostics,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Fallback: generic codex_failed
  // -----------------------------------------------------------------------
  return {
    failure_class: "codex_failed",
    detected_reason: `Codex runner exited with code ${exitCode !== null ? exitCode : "unknown"} and the failure could not be classified into a specific category.`,
    severity: "failed",
    operator_action: "Investigate the runner logs and stderr output for details. The failure requires manual diagnosis.",
    creates_repair_task: false,
    creates_retry_followup: true,
    diagnostics,
  };
}
