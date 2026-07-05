/**
 * codex-result-contract-normalizer.mjs — Backend Result Contract Normalizer
 *
 * P0-UA3b: Normalizes result contract fields for task finalization and
 * convergence.  Accepts structured inputs and produces canonical result
 * fields so that downstream consumers (task-finalizer, task-convergence,
 * task-final-writeback) have a consistent, non-contradictory view of the
 * task outcome.
 *
 * Core invariants enforced by this module:
 *   1. Free-form summary text alone must never mark a task as passed.
 *   2. Explicit failures and blocker findings must remain blocking.
 *   3. Structured evidence (tests, exit codes, release reports, commit
 *      reachability, integration, delivery_result_recovery) always takes
 *      precedence over summary text.
 *   4. A result with no structured evidence defaults to status=null, not
 *      completed.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COMPLETED = 'completed';
const STATUS_FAILED = 'failed';

const EMPTY_COMMIT_VALUES = new Set(['', 'none', 'null', 'undefined']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCommit(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return EMPTY_COMMIT_VALUES.has(text.toLowerCase()) ? null : text;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hasStringValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Check whether an exit code indicates success (0 or null/undefined).
 * @param {number|null|undefined} code
 * @returns {boolean}
 */
function exitCodeIsZero(code) {
  return code === 0 || code === null || code === undefined;
}

/**
 * Check whether a tests string contains a pass indicator.
 * Looks for common patterns like "pass", "passed", "ok", "0 failed".
 * @param {string|null} tests
 * @returns {boolean}
 */
function testsIndicatePass(tests) {
  if (!hasStringValue(tests)) return false;
  const lower = tests.toLowerCase();
  // Explicit fail patterns override pass patterns
  if (/fail(ed|ure)?/.test(lower) && !/0 (fail(ed|ure)?|error)/.test(lower)) return false;
  // Positive indicators
  if (/\b(pass|passed|ok)\b/.test(lower)) return true;
  if (/0 (fail(ed|ure)?|error|warning)/.test(lower)) return true;
  if (/all (tests|checks|commands).*(pass|succeed|ok)/.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Normalization steps
// ---------------------------------------------------------------------------

/**
 * Normalize `verification.passed` from structured inputs.
 *
 * Rules (first match wins):
 *   1. Explicit verification.passed=true/false from delivery_result_recovery
 *      is authoritative.
 *   2. A release report with passed===true that has commands normalizes to
 *      passed=true.
 *   3. All commands exit code 0 AND tests indicate pass => passed=true.
 *   4. Any command non-zero OR tests indicate fail => passed=false.
 *   5. tests-only (no commands) with pass indicator => passed=true.
 *   6. tests-only with fail indicator => passed=false.
 *   7. Summary-only (no tests, no commands, no report, no exit codes) =>
 *      passed=null (must not be inferred from summary text alone).
 *
 * @param {object} input
 * @returns {{ passed: boolean|null, reason: string|null, commands: Array }}
 */
export function normalizeVerificationPassed(input = {}) {
  const {
    tests,
    exitCode,
    releaseReport,
    deliveryResultRecovery,
    changedFiles,
  } = input;

  const commands = [];
  const recoveryVerification = asObject(deliveryResultRecovery?.verification);
  const report = asObject(releaseReport);

  // 1. delivery_result_recovery verification is authoritative when present
  if (Object.keys(recoveryVerification).length > 0) {
    const recoveryCommands = list(recoveryVerification.commands).map(c => ({
      cmd: c.cmd || c.command || String(c),
      exit_code: typeof c.exit_code === 'number' ? c.exit_code : (c.passed === true ? 0 : 1),
    }));
    commands.push(...recoveryCommands);
    if (recoveryVerification.passed === true) {
      return { passed: true, reason: 'delivery_result_recovery_verification_passed', commands };
    }
    if (recoveryVerification.passed === false) {
      return { passed: false, reason: 'delivery_result_recovery_verification_failed', commands };
    }
  }

  // 2. Release report with passed===true and commands
  if (report.passed === true) {
    const reportCommands = list(report.commands).map(c => ({
      cmd: c.cmd || c.command || String(c),
      exit_code: typeof c.exit_code === 'number' ? c.exit_code : 0,
    }));
    commands.push(...reportCommands);
    if (reportCommands.length > 0) {
      return { passed: true, reason: 'release_report_passed_with_commands', commands };
    }
    // report.passed=true but no commands counts as summary-only
  }

  // 3. Exit code zero + tests pass
  const hasTests = hasStringValue(tests);
  const exitZero = exitCodeIsZero(exitCode);

  if (exitZero && hasTests && testsIndicatePass(tests)) {
    commands.push({ cmd: `tests: ${tests.slice(0, 200)}`, exit_code: 0 });
    return { passed: true, reason: 'exit_code_zero_and_tests_pass', commands };
  }

  // 4. Non-zero exit code OR tests indicate fail
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    commands.push({ cmd: `process exit code: ${exitCode}`, exit_code: exitCode });
    return { passed: false, reason: `non_zero_exit_code_${exitCode}`, commands };
  }

  if (hasTests && !testsIndicatePass(tests)) {
    commands.push({ cmd: `tests: ${tests.slice(0, 200)}`, exit_code: 1 });
    return { passed: false, reason: 'tests_indicate_failure', commands };
  }

  // 5. tests-only with pass indicator (no exit code available)
  if (hasTests && testsIndicatePass(tests)) {
    commands.push({ cmd: `tests: ${tests.slice(0, 200)}`, exit_code: 0 });
    return { passed: true, reason: 'tests_only_pass', commands };
  }

  // 6. No structured evidence at all -- summary-only must never infer pass
  const hasChangedFiles = list(changedFiles).length > 0;
  if (!hasTests && !hasChangedFiles && exitZero) {
    return { passed: null, reason: 'no_structured_evidence_summary_only', commands: [] };
  }

  // Edge: changed files but no tests, no exit code, no report
  if (hasChangedFiles && !hasTests && exitZero) {
    return { passed: null, reason: 'changed_files_only_no_verification_evidence', commands: [] };
  }

  return { passed: null, reason: 'insufficient_structured_evidence', commands: [] };
}

/**
 * Normalize `acceptance_gate` from structured inputs.
 *
 * @param {object} input
 * @returns {{ passed: boolean|null, reason: string|null }}
 */
export function normalizeAcceptanceGate(input = {}) {
  const verification = normalizeVerificationPassed(input);
  const { deliveryResultRecovery } = input;
  const recovery = asObject(deliveryResultRecovery);

  // If delivery_result_recovery explicitly marks reason as already_integrated,
  // acceptance gate passes if commit is integrated.
  if (recovery.reason === 'already_integrated' && recovery.commit_integrated === true) {
    return { passed: true, reason: 'already_integrated_acceptance_gate_passed' };
  }

  // Acceptance follows verification unless blocked by explicit blockers
  if (verification.passed === true) {
    return { passed: true, reason: 'verification_passed_acceptance_gate_passed' };
  }

  if (verification.passed === false) {
    return { passed: false, reason: 'verification_failed_acceptance_gate_failed' };
  }

  // No verification evidence -- do not pass acceptance
  return { passed: null, reason: 'no_verification_evidence_acceptance_gate_not_determined' };
}

/**
 * Normalize `contract_verification.blocking_passed` from structured inputs.
 *
 * @param {object} input
 * @returns {{ blocking_passed: boolean, reason: string }}
 */
export function normalizeContractBlockingPassed(input = {}) {
  const { deliveryResultRecovery } = input;
  const recovery = asObject(deliveryResultRecovery);
  const commitReachability = asObject(input.commitReachability);
  const integration = asObject(input.integration);

  // Delivery recovery with commit_integrated=true and no blockers means blocking passed
  if (recovery.commit_integrated === true && recovery.reason) {
    if (recovery.reason !== 'recovery_failed') {
      return { blocking_passed: true, reason: `delivery_recovery_${recovery.reason}` };
    }
  }

  // If reachability says local_head is unreachable, blocking fails
  if (commitReachability.reachable === false) {
    return { blocking_passed: false, reason: 'local_head_unreachable_not_integrated' };
  }

  // If integration says merged/already_integrated, blocking passes
  if (integration.merged === true || integration.already_integrated === true) {
    return { blocking_passed: true, reason: 'integration_merged_or_already_integrated' };
  }

  // Summary-only: default to blocking NOT passed (invariant enforcement)
  return { blocking_passed: false, reason: 'no_contract_verification_evidence' };
}

/**
 * Normalize delivery_result_recovery fields.
 *
 * @param {object} input
 * @returns {object|null} Normalized delivery_result_recovery or null
 */
export function normalizeDeliveryResultRecovery(input = {}) {
  if (!input.deliveryResultRecovery) return null;
  const recovery = asObject(input.deliveryResultRecovery);
  const commitReachability = asObject(input.commitReachability);

  const reason = recovery.reason || null;
  const commitIntegrated = recovery.commit_integrated === true ||
    commitReachability.reachable === true;
  const commit = normalizeCommit(recovery.commit || input.commitReachability?.commit);
  const localHead = normalizeCommit(recovery.local_head || commitReachability.local_head);
  const remoteHead = normalizeCommit(recovery.remote_head || commitReachability.remote_head);

  return {
    reason,
    commit_integrated: commitIntegrated,
    commit,
    local_head: localHead,
    remote_head: remoteHead,
  };
}

/**
 * Normalize integration status from structured inputs.
 *
 * @param {object} input
 * @returns {{ status: string|null, merged: boolean, already_integrated: boolean }}
 */
export function normalizeIntegration(input = {}) {
  const integration = asObject(input.integration);
  const commitReachability = asObject(input.commitReachability);

  const alreadyIntegrated = integration.already_integrated === true ||
    (commitReachability.reachable === true && commitReachability.canonical_clean === true);

  let status = null;
  if (integration.merged === true || integration.status === 'merged') {
    status = 'merged';
  } else if (alreadyIntegrated) {
    status = 'already_integrated';
  } else if (integration.status) {
    status = integration.status;
  }

  return {
    status,
    merged: integration.merged === true,
    already_integrated: alreadyIntegrated,
  };
}

// ---------------------------------------------------------------------------
// Main normalization entry point
// ---------------------------------------------------------------------------

/**
 * Normalize a result contract from structured inputs.
 *
 * This is the single entry point that produces canonical result fields for
 * task finalization.  It never infers "passed" from summary text alone and
 * always preserves explicit failures and blocker findings.
 *
 * @param {object} input
 * @returns {object} Canonical result with normalized fields
 */
export function normalizeResultContract(input) {
  // Guard against null/undefined input
  if (!input || typeof input !== 'object') {
    input = {};
  }

  const existingResult = asObject(input.existingResult);
  const changedFiles = list(input.changedFiles || existingResult.changed_files);
  const summary = input.summary || existingResult.summary || '';
  const status = input.status || existingResult.status || null;

  // Normalize each component
  const verification = normalizeVerificationPassed(input);
  const acceptanceGate = normalizeAcceptanceGate(input);
  const contractBlocking = normalizeContractBlockingPassed(input);
  const deliveryResultRecovery = normalizeDeliveryResultRecovery(input);
  const integration = normalizeIntegration(input);

  // Derive closure_decision
  const closureDecision = {
    status: verification.passed === true ? STATUS_COMPLETED : null,
    blocking_passed: contractBlocking.blocking_passed,
    reason: verification.reason || 'no_structured_evidence',
  };

  // Derive finalizer_decision
  const finalizerDecision = {
    status: verification.passed === true && contractBlocking.blocking_passed === true
      ? STATUS_COMPLETED
      : (verification.passed === false ? STATUS_FAILED : null),
    verification_passed: verification.passed,
    acceptance_gate_passed: acceptanceGate.passed,
    blocking_passed: contractBlocking.blocking_passed,
    reason: contractBlocking.blocking_passed
      ? 'terminal_evidence_satisfied'
      : (verification.passed === false ? 'verification_failed' : 'insufficient_evidence'),
  };

  // Build normalized result
  const normalized = {
    status,
    summary,
    changed_files: changedFiles,
    verification: {
      passed: verification.passed,
      commands: verification.commands,
      reason: verification.reason,
    },
    tests: input.tests || existingResult.tests || null,
    acceptance_gate: acceptanceGate,
    contract_verification: {
      blocking_passed: contractBlocking.blocking_passed,
    },
    delivery_result_recovery: deliveryResultRecovery,
    integration,
    closure_decision: closureDecision,
    finalizer_decision: finalizerDecision,
    result_contract_normalized: true,
    // Preserve existing fields, then override with normalized values
    ...existingResult,
    changed_files: changedFiles,
    verification: {
      passed: verification.passed,
      commands: verification.commands,
      reason: verification.reason,
    },
    acceptance_gate: acceptanceGate,
    contract_verification: {
      blocking_passed: contractBlocking.blocking_passed,
    },
    delivery_result_recovery: deliveryResultRecovery,
    integration,
    closure_decision: closureDecision,
    finalizer_decision: finalizerDecision,
    result_contract_normalized: true,
  };

  // Clean up: remove key duplicates from spread
  delete normalized.status;
  normalized.status = status;
  delete normalized.summary;
  normalized.summary = summary;
  delete normalized.tests;
  normalized.tests = input.tests || existingResult.tests || null;

  return normalized;
}
