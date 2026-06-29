/**
 * failure-classifier.mjs — Failure classification for Codex task results.
 *
 * Classifies failures into categories that determine repair eligibility,
 * notification strategy, and terminal-state decisions.
 *
 * Provides both simple string-based classification (classifyFailure) and
 * structured classification (classifyFailureStructured) with retryable,
 * repairable, confidence, nextStatusHint, and evidence fields.
 */

/** Simple string-based classification (backward compatible) */
export function classifyFailure(input = {}) {
  const result = input.resultJson || input.result || {};
  const error = input.error || {};
  const message = String(input.message || error.message || result.summary || "").toLowerCase();

  // ---- P0: Network failure classes ----
  // Checked before code-level failures to prevent transient network issues
  // from being misclassified as repairable code failures.
  if (
    input.rateLimited ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded")
  ) return "rate_limited";

  if (
    input.gatewayError ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("gateway") ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("upstream")
  ) return "gateway_error";

  if (
    input.transientNetworkError ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    (message.includes("enotfound") && !message.includes("test"))
  ) return "transient_network_error";

  if (
    input.codexTimeout ||
    result.codex_timeout ||
    message.includes("codex timeout") ||
    message.includes("codex execution timed out")
  ) return "codex_timeout";

  // ---- Code-level failure classes ----
  if (input.missingResultJson || (message.includes("result.json") && message.includes("missing"))) return "missing_result_json";
  if (input.invalidResultJson || (message.includes("json") && (message.includes("parse") || message.includes("invalid")))) return "invalid_result_json";
  if (input.noFirstOutputTimeout || result.no_first_output_timeout || message.includes("first-output timeout")) return "first_output_timeout";
  if (input.mergeConflict || message.includes("merge conflict") || message.includes("conflict")) return "merge_conflict";
  if (result.verification?.passed === false || input.verification?.passed === false || message.includes("test failed") || message.includes("tests failed")) return "test_failed";
  if (input.staleRunningTask || message.includes("stale running")) return "stale_running_task";
  if (result.status === "failed") return "task_failed";
  return "unknown";
}

function textOf(...values) {
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value))
    .join("\n")
    .toLowerCase();
}

function failedCommands(verification = {}) {
  return Array.isArray(verification.commands)
    ? verification.commands.filter((command) => Number(command?.exit_code) !== 0)
    : [];
}

function findingText(verification = {}) {
  return Array.isArray(verification.findings)
    ? verification.findings.map((finding) => [finding.code, finding.message, finding.source].filter(Boolean).join(" ")).join("\n")
    : "";
}

function commandFailureClass(command = {}) {
  const cmd = String(command.cmd || command.command || "").toLowerCase();
  const output = textOf(command.stdout_tail, command.stderr_tail, command.stdout, command.stderr);
  if (cmd === "git diff --check" || cmd.includes("git diff --check")) return "git_diff_check_failed";
  if (/\b(typecheck|tsc|typescript)\b/.test(cmd) || /\b(typecheck|tsc|typescript)\b/.test(output)) return "typecheck_failed";
  if (/\blint\b/.test(cmd) || /\blint\b/.test(output)) return "lint_failed";
  if (/\bbuild\b/.test(cmd) || /\bbuild\b/.test(output)) return "build_failed";
  if (/\b(test|node --test|pytest|go test|cargo test|mvn test)\b/.test(cmd) || /\b(test failed|tests failed|failing|failed test)\b/.test(output)) return "test_failed";
  return null;
}

const TASK_FAILURE_DEFINITIONS = {
  missing_result_json: { repairable: true, repair_strategy: "repair_result_contract", reason: "result.json is missing or was not written." },
  invalid_result_json: { repairable: true, repair_strategy: "repair_result_contract", reason: "result.json is invalid or cannot be parsed." },
  test_failed: { repairable: true, repair_strategy: "repair_failed_command", reason: "Verification test command failed." },
  build_failed: { repairable: true, repair_strategy: "repair_failed_command", reason: "Verification build command failed." },
  lint_failed: { repairable: true, repair_strategy: "repair_failed_command", reason: "Verification lint command failed." },
  typecheck_failed: { repairable: true, repair_strategy: "repair_failed_command", reason: "Verification typecheck command failed." },
  git_diff_check_failed: { repairable: true, repair_strategy: "repair_formatting", reason: "git diff --check failed." },
  no_first_output_timeout: { repairable: true, repair_strategy: "repair_finalizer_retry", reason: "Codex produced no first output before timeout." },
  codex_timeout: { repairable: false, repair_strategy: "manual_review_timeout", reason: "Codex execution timed out." },
  merge_conflict: { repairable: false, repair_strategy: "conflict_resolver_or_review", reason: "A merge conflict requires conflict resolution or manual review." },
  unknown: { repairable: false, repair_strategy: "manual_review", reason: "Failure could not be classified." },
};

function taskFailure(failureClass, overrides = {}) {
  const base = TASK_FAILURE_DEFINITIONS[failureClass] || TASK_FAILURE_DEFINITIONS.unknown;
  return {
    failure_class: failureClass in TASK_FAILURE_DEFINITIONS ? failureClass : "unknown",
    repairable: base.repairable,
    reason: overrides.reason || base.reason,
    repair_strategy: overrides.repair_strategy || base.repair_strategy,
  };
}

/**
 * Classify a task execution or verification failure for repair retry handling.
 *
 * @param {object} options
 * @param {object} [options.task]
 * @param {object} [options.codexResult]
 * @param {object} [options.verification]
 * @param {Error|object|string} [options.error]
 * @returns {{ failure_class: string, repairable: boolean, reason: string, repair_strategy: string }}
 */
export function classifyTaskFailure({ task = {}, codexResult = {}, verification = {}, error = null } = {}) {
  const findings = findingText(verification);
  const combined = textOf(
    findings,
    error,
    codexResult.summary,
    codexResult.kind,
    codexResult.failure_class,
    task.failure_class,
    task.result?.failure_class,
    task.result?.summary,
  );

  if (codexResult.failure_class && TASK_FAILURE_DEFINITIONS[codexResult.failure_class]) {
    return taskFailure(codexResult.failure_class, { reason: codexResult.summary || undefined });
  }
  if (verification.failure_class && TASK_FAILURE_DEFINITIONS[verification.failure_class]) {
    return taskFailure(verification.failure_class);
  }

  if (/result_json_missing|missing_result_json|result\.json[^\n]*(missing|not found)|no task result data/.test(combined)) {
    return taskFailure("missing_result_json");
  }
  if (/result_json_invalid|invalid_result_json|invalid result\.json|json[^\n]*(parse|invalid|unexpected token)/.test(combined)) {
    return taskFailure("invalid_result_json");
  }
  if (codexResult.no_first_output_timeout === true || /no_first_output_timeout|first[- ]output timeout|no stdout\/stderr before/.test(combined)) {
    return taskFailure("no_first_output_timeout");
  }
  if (codexResult.timed_out === true || codexResult.kind === "codex_timeout" || /codex_timeout|codex timeout|execution timed out/.test(combined)) {
    return taskFailure("codex_timeout");
  }
  if (/merge_conflict|merge conflict|\bconflict\b|^conflict/.test(combined)) {
    return taskFailure("merge_conflict");
  }

  const failed = failedCommands(verification);
  for (const command of failed) {
    const classified = commandFailureClass(command);
    if (classified) {
      return taskFailure(classified, { reason: `${command.cmd || command.command || "verification command"} failed.` });
    }
  }

  if (verification.passed === false || /verification_command_failed|verification_failed|test failed|tests failed/.test(combined)) {
    return taskFailure("test_failed");
  }

  return taskFailure("unknown");
}

/**
 * Return true when a repair attempt is allowed for a classified task failure.
 * First run is attempt=0; default max_attempts=2 allows one repair attempt.
 */
export function canRetryTask(task = {}, failure = {}) {
  if (failure?.repairable !== true) return false;
  const attempt = Number.isInteger(task.attempt) ? task.attempt : Number(task.repair_attempt || 0);
  const maxAttempts = Number.isInteger(task.max_attempts) ? task.max_attempts : Number(task.maxAttempts || 2);
  return attempt + 1 < maxAttempts;
}

/**
 * Determine if a failure class should trigger automatic repair.
 *
 * Only code-level failures are repairable. Network errors (rate_limited,
 * gateway_error, transient_network_error, codex_timeout) are terminal
 * and should NOT enter the repair loop — retrying them is counterproductive
 * and may exacerbate resource exhaustion.
 *
 * @param {string} failureClass
 * @returns {boolean}
 */
export function failureClassRequiresRepair(failureClass) {
  // Network and terminal failures are not repairable
  if (failureClassIsTerminalNonRepairable(failureClass)) return false;
  // Only code-level failures that can be addressed by re-running repairs
  return new Set([
    "missing_result_json",
    "invalid_result_json",
    "test_failed",
    "first_output_timeout",
    "merge_conflict",
  ]).has(failureClass);
}

/**
 * Check whether a failure class is terminal-but-non-repairable.
 *
 * These failures (e.g., rate limiting, gateway errors) cannot be fixed
 * by re-running the same operation and must be escalated, blocked, or
 * handled at the infrastructure level. The repair loop must NOT retry
 * these.
 *
 * @param {string} failureClass
 * @returns {boolean}
 */
export function failureClassIsTerminalNonRepairable(failureClass) {
  return new Set([
    "rate_limited",
    "quota_exceeded",
    "gateway_error",
    "service_unavailable",
    "transient_network_error",
    "provider_interruption",
    "execution_timeout",
    "startup_timeout",
    "result_missing",
    "codex_timeout",
    "stale_running_task",
    "task_failed",
  ]).has(failureClass);
}

// ---------------------------------------------------------------------------
// Structured failure classification (P0)
// ---------------------------------------------------------------------------
// Returns a full structured object with retryable, repairable, nextStatusHint,
// confidence, and evidence fields. This is the preferred interface for the
// unified convergence module.

const FAILURE_CLASS_STRUCTURED = {
  rate_limited: {
    class: "rate_limited",
    retryable: true,
    repairable: false,
    nextStatusHint: "quota_wait",
    confidence: "high",
    description: "Rate limited by API provider",
  },
  quota_exceeded: {
    class: "quota_exceeded",
    retryable: true,
    repairable: false,
    nextStatusHint: "quota_wait",
    confidence: "high",
    description: "Quota exceeded for API usage",
  },
  gateway_error: {
    class: "gateway_error",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "high",
    description: "Gateway error from upstream provider",
  },
  service_unavailable: {
    class: "service_unavailable",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "high",
    description: "Service unavailable from upstream provider",
  },
  transient_network_error: {
    class: "transient_network_error",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "high",
    description: "Transient network error (connection reset, timeout, DNS)",
  },
  provider_interruption: {
    class: "provider_interruption",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "medium",
    description: "Provider interruption (stdout empty, stderr large, exit 1)",
  },
  execution_timeout: {
    class: "execution_timeout",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "high",
    description: "Codex execution timed out",
  },
  startup_timeout: {
    class: "startup_timeout",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "high",
    description: "Codex startup timed out (no first output)",
  },
  result_missing: {
    class: "result_missing",
    retryable: true,
    repairable: false,
    nextStatusHint: "retry_wait",
    confidence: "medium",
    description: "Result.json missing from task execution",
  },
  verification_failed: {
    class: "verification_failed",
    retryable: false,
    repairable: true,
    nextStatusHint: "waiting_for_repair",
    confidence: "high",
    description: "Task acceptance verification failed",
  },
  implementation_failed: {
    class: "implementation_failed",
    retryable: false,
    repairable: true,
    nextStatusHint: "waiting_for_repair",
    confidence: "medium",
    description: "Task implementation failed",
  },
  test_failed: {
    class: "test_failed",
    retryable: false,
    repairable: true,
    nextStatusHint: "waiting_for_repair",
    confidence: "high",
    description: "Tests failed during verification",
  },
  unknown_failure: {
    class: "unknown_failure",
    retryable: false,
    repairable: false,
    nextStatusHint: "failed",
    confidence: "low",
    description: "Unclassified failure",
  },
};

/**
 * Classify a task failure into a structured object with full metadata.
 *
 * @param {object} [input={}] - Same input as classifyFailure
 * @returns {{
 *   class: string,
 *   retryable: boolean,
 *   repairable: boolean,
 *   nextStatusHint: string,
 *   confidence: string,
 *   evidence: string[],
 *   description: string
 * }}
 */
export function classifyFailureStructured(input = {}) {
  const simple = classifyFailure(input);
  const evidence = [];

  // Collect evidence
  if (input.error) evidence.push(`error: ${input.error.message || String(input.error)}`);
  if (input.message) evidence.push(`message: ${input.message}`);
  if (input.rateLimited) evidence.push("rateLimited flag set");
  if (input.gatewayError) evidence.push("gatewayError flag set");
  if (input.transientNetworkError) evidence.push("transientNetworkError flag set");
  if (input.codexTimeout) evidence.push("codexTimeout flag set");
  if (input.missingResultJson) evidence.push("missingResultJson flag set");
  if (input.noFirstOutputTimeout) evidence.push("noFirstOutputTimeout flag set");

  // Map simple class to structured definition
  const structured = FAILURE_CLASS_STRUCTURED[simple];
  if (structured) {
    return { ...structured, evidence };
  }

  // Fallback: unknown
  return { ...FAILURE_CLASS_STRUCTURED.unknown_failure, evidence, class: simple || "unknown_failure" };
}

/**
 * Get the structured definition for a given failure class name.
 *
 * @param {string} failureClass - Failure class name
 * @returns {object|null} Structured definition or null if unknown
 */
export function getFailureClassDefinition(failureClass) {
  return FAILURE_CLASS_STRUCTURED[failureClass] || null;
}

/**
 * Check if a failure class has a quarantine/backoff hint (quota_wait or retry_wait).
 *
 * @param {string} failureClass
 * @returns {boolean}
 */
export function failureClassIsQuarantined(failureClass) {
  const def = getFailureClassDefinition(failureClass);
  if (!def) return false;
  return def.nextStatusHint === "quota_wait" || def.nextStatusHint === "retry_wait";
}
