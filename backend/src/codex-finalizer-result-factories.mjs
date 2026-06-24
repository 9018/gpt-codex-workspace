import { KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT, STATUS_COMPLETED, STATUS_FAILED, STATUS_TIMED_OUT } from "./codex-finalizer-constants.mjs";
import { evaluateAcceptance } from "./acceptance-policy.mjs";

function acceptanceFields(fields = {}, defaultFindings = []) {
  const acceptance_findings = Array.isArray(fields.acceptance_findings) ? fields.acceptance_findings : defaultFindings;
  const decision = evaluateAcceptance({ findings: acceptance_findings });
  const reviewer_decision = fields.reviewer_decision || {
    status: decision.status,
    passed: decision.passed,
    blocking_count: decision.blocking_count,
    residual_count: decision.residual_count,
  };
  const next_tasks = Array.isArray(fields.next_tasks) && fields.next_tasks.length > 0 ? fields.next_tasks : decision.next_tasks;
  const repair_proposal = fields.repair_proposal || (decision.repair_proposals.length > 0
    ? { repair_proposals: decision.repair_proposals, acceptance_findings }
    : null);
  return { reviewer_decision, acceptance_findings, next_tasks, repair_proposal };
}

export function createSuccessResult(fields = {}) {
  const acceptance = acceptanceFields(fields);
  return {
    status: STATUS_COMPLETED,
    kind: KIND_EXECUTED,
    summary: fields.summary || null,
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    tests: fields.tests || null,
    commit: fields.commit || null,
    remote_head: fields.remote_head || null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: acceptance.reviewer_decision,
    acceptance_findings: acceptance.acceptance_findings,
    next_tasks: acceptance.next_tasks,
    repair_proposal: acceptance.repair_proposal,
    completed_at: fields.completed_at || new Date().toISOString(),
  };
}

/**
 * Build a standardized no-op result object.
 *
 * Semantically equivalent to createSuccessResult() but explicitly marks
 * the result as a no-op (noop: true) and leaves change/tests/commit fields
 * empty, signifying that no meaningful work was done.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant no-op result.
 */
export function createNoopResult(fields = {}) {
  const acceptance = acceptanceFields(fields);
  return {
    status: STATUS_COMPLETED,
    kind: KIND_EXECUTED,
    summary: fields.summary || 'No changes needed (no-op)',
    changed_files: [],
    tests: null,
    commit: null,
    remote_head: null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: acceptance.reviewer_decision,
    acceptance_findings: acceptance.acceptance_findings,
    next_tasks: acceptance.next_tasks,
    repair_proposal: acceptance.repair_proposal,
    completed_at: fields.completed_at || new Date().toISOString(),
    noop: true,
  };
}

/**
 * Build a standardized failure result object.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {string[]}[fields.changed_files]
 * @param {string}  [fields.tests]
 * @param {string}  [fields.commit]
 * @param {string}  [fields.remote_head]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant failure result.
 */
export function createFailedResult(fields = {}) {
  const defaultFindings = Array.isArray(fields.acceptance_findings) ? [] : [{ severity: 'major', code: 'codex_execution_failed', message: fields.summary || 'Codex execution failed', source: 'finalizer_policy' }];
  const acceptance = acceptanceFields(fields, defaultFindings);
  return {
    status: STATUS_FAILED,
    kind: KIND_FAILED,
    summary: fields.summary || 'Codex execution failed',
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    tests: fields.tests || null,
    commit: fields.commit || null,
    remote_head: fields.remote_head || null,
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: acceptance.reviewer_decision,
    acceptance_findings: acceptance.acceptance_findings,
    next_tasks: acceptance.next_tasks,
    repair_proposal: acceptance.repair_proposal,
    completed_at: fields.completed_at || new Date().toISOString(),
    timed_out: false,
  };
}

/**
 * Build a standardized timeout result object.
 *
 * @param {object}  [fields]
 * @param {string}  [fields.summary]
 * @param {number}  [fields.timeoutSeconds]
 * @param {string[]}[fields.changed_files]
 * @param {string[]}[fields.warnings]
 * @param {string[]}[fields.followups]
 * @param {string}  [fields.completed_at]  — defaults to new Date().toISOString()
 * @returns {object} A contract-compliant timeout result.
 */
export function createTimeoutResult(fields = {}) {
  const defaultFindings = Array.isArray(fields.acceptance_findings) ? [] : [{ severity: 'major', code: 'codex_execution_timed_out', message: fields.summary || 'Codex execution timed out', source: 'finalizer_policy' }];
  const acceptance = acceptanceFields(fields, defaultFindings);
  return {
    status: STATUS_TIMED_OUT,
    kind: KIND_TIMEOUT,
    summary: fields.summary || 'Codex execution timed out',
    changed_files: Array.isArray(fields.changed_files) ? fields.changed_files : [],
    warnings: Array.isArray(fields.warnings) ? fields.warnings : [],
    followups: Array.isArray(fields.followups) ? fields.followups : [],
    reviewer_decision: acceptance.reviewer_decision,
    acceptance_findings: acceptance.acceptance_findings,
    next_tasks: acceptance.next_tasks,
    repair_proposal: acceptance.repair_proposal,
    completed_at: fields.completed_at || new Date().toISOString(),
    timed_out: true,
    timeout_seconds: typeof fields.timeoutSeconds === 'number' ? fields.timeoutSeconds : 0,
  };
}

// ===========================================================================
// Validation
// ===========================================================================

/**
 * Validate a result object against the finalizer contract shape.
 *
 * Checks field types according to the contract documented at the top of
 * this module.  Reports all problems found (not just the first one).
 *
 * @param {*} result - The value to validate.
 * @returns {{ valid: boolean, errors: string[] }}
 */
