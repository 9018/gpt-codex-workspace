import {
  RESULT_SHAPE_TYPES,
  classifyResultShape,
} from './result-shape-classifier.mjs';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TASK_STATUSES,
  isActiveExecutionStatus,
  isKnownTaskStatus,
  normalizeTaskStatus,
} from './task-status-taxonomy.mjs';

export const CURRENT_WORK_DECISION_LABELS = Object.freeze({
  ACTIVE: 'active',
  REVIEW: 'review',
  INTEGRATION: 'integration',
  COMPLETED: 'completed',
  PROVIDER_EMPTY: 'provider_empty',
  FAILURE_EVIDENCE: 'failure_evidence',
  CODE_EVIDENCE_FAILURE: 'code_evidence_failure',
  RESOLVED_BY_OPTIONS: 'resolved_by_options',
  UNKNOWN_STATUS: 'unknown_status',
});

const PROVIDER_EMPTY_RESULT_SHAPES = Object.freeze(new Set([
  RESULT_SHAPE_TYPES.NO_RESULT,
  RESULT_SHAPE_TYPES.PROVIDER_NOOP,
  RESULT_SHAPE_TYPES.PROVIDER_TIMEOUT,
  RESULT_SHAPE_TYPES.PROVIDER_NO_EVIDENCE,
]));

// P0-MA11: Normalize verification - if canonical verification.passed=true
// and contract_verification.blocking_passed=true, final_verification is stale
// and should not produce current blockers.
export function isVerificationNormalized(result) {
  if (!result || typeof result !== 'object') return false;
  const verification = result.verification || {};
  const contractV = result.contract_verification || {};
  if (verification.passed === true && contractV.blocking_passed === true) return true;
  if (result.acceptance_gate?.passed === true && result.closure_decision?.blocking_passed === true) return true;

  // P0-MA11-R2/MA12-G3: Also check repo head reachability from legacy
  // result.commit and delivery-recovery commit/local_head.  Some historical
  // tasks recorded result.commit="none" even though delivery recovery retained
  // a local_head that was later integrated into the canonical repo.
  const integratedCommit = getVerifiedIntegratedCommitCandidate(result);
  if (integratedCommit) {
    result.delivery_result_recovery = result.delivery_result_recovery || {};
    result.delivery_result_recovery.reason = 'already_integrated';
    result.delivery_result_recovery.recovered = true;
    result.delivery_result_recovery.commit = integratedCommit;
    result.delivery_result_recovery.commit_integrated = true;
    return true;
  }

  // P0-MA11-R1: Check for delivery_result_recovery already_integrated
  // When a task has a commit that is already integrated in the canonical repo,
  // empty_commit/no_staged_changes from delivery recovery is not a real blocker.
  const deliveryRecovery = result.delivery_result_recovery;
  if (deliveryRecovery && deliveryRecovery.reason === 'already_integrated' && deliveryRecovery.recovered === true) {
    // Only consider normalized if the task also has passing verification evidence
    if (result.verification?.passed === true || result.tests) {
      return true;
    }
  }

  return false;
}

export function classifyCurrentBlockerTask(task) {
  const record = normalizeTaskRecord(task);
  const status = normalizeTaskStatus(record?.status);
  const result = record?.result;
  const resultShape = classifyResultShape(result);

  if (!isKnownTaskStatus(status)) return decision(CURRENT_WORK_DECISION_LABELS.UNKNOWN_STATUS, status, resultShape, false);
  if (isResolvedByOptions(result)) return decision(CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS, status, resultShape, false);

  // P0-MA11-R2/MA12-G3: Populate delivery_result_recovery from reachable
  // commit evidence so downstream consumers do not block on stale review state.
  const integratedCommit = getVerifiedIntegratedCommitCandidate(result);
  if (integratedCommit) {
    result.delivery_result_recovery = result.delivery_result_recovery || {};
    result.delivery_result_recovery.reason = 'already_integrated';
    result.delivery_result_recovery.recovered = true;
    result.delivery_result_recovery.commit = integratedCommit;
    result.delivery_result_recovery.commit_integrated = true;
  }

  // P0-MA11: If canonical verification is normalized, stale review states are not blockers
  const verificationNormalized = isVerificationNormalized(result);
  
  if (status === TASK_STATUSES.WAITING_FOR_REVIEW) {
    if (isVerifiedReadOnlyResult(result)) return decision(CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS, status, resultShape, false);
    return decision(CURRENT_WORK_DECISION_LABELS.REVIEW, status, resultShape, 
      verificationNormalized ? false : hasActionableReviewEvidence(result, resultShape));
  }
  if (status === TASK_STATUSES.WAITING_FOR_REPAIR) {
    // P0-MA11-R1: If task has already-integrated commit with passing verification,
    // waiting_for_repair due to empty_commit noise is not a current blocker.
    if (verificationNormalized && hasVerificationEvidence(result)) {
      return decision(CURRENT_WORK_DECISION_LABELS.REVIEW, status, resultShape, false);
    }
    return decision(CURRENT_WORK_DECISION_LABELS.REVIEW, status, resultShape, true);
  }
  if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
    return decision(CURRENT_WORK_DECISION_LABELS.INTEGRATION, status, resultShape, true);
  }
  if (isActiveExecutionStatus(status)) return decision(CURRENT_WORK_DECISION_LABELS.ACTIVE, status, resultShape, true);
  if (status === TASK_STATUSES.COMPLETED) return decision(CURRENT_WORK_DECISION_LABELS.COMPLETED, status, resultShape, false);
  if (PROVIDER_EMPTY_RESULT_SHAPES.has(resultShape)) return decision(CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY, status, resultShape, false);
  if (resultShape === RESULT_SHAPE_TYPES.FAILURE_EVIDENCE) {
    return decision(CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE, status, resultShape, true);
  }
  if (resultShape === RESULT_SHAPE_TYPES.CODE_EVIDENCE) {
    return decision(CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE, status, resultShape, true);
  }

  return decision(CURRENT_WORK_DECISION_LABELS.UNKNOWN_STATUS, status, resultShape, false);
}

function normalizeTaskRecord(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  return task;
}

function isResolvedByOptions(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return result.resolved_legacy === true
    || hasStringEvidence(result.resolved_by_task_id)
    || hasStringEvidence(result.superseded_by_task_id)
    || result.noop === true;
}

function hasStringEvidence(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasVerificationEvidence(result) {
  return result?.verification?.passed === true || hasStringEvidence(result?.tests);
}

function isValidCommitCandidate(value) {
  if (!hasStringEvidence(value)) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'null' || normalized === 'undefined') return false;
  return /^[0-9a-f]{7,40}$/i.test(normalized);
}

function getVerifiedIntegratedCommitCandidate(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (!hasVerificationEvidence(result)) return null;
  const deliveryRecovery = result.delivery_result_recovery || result.delivery_recovery || {};
  const candidates = [result.commit, deliveryRecovery.commit, deliveryRecovery.local_head];
  const repoPath = result.execution_cwd || deliveryRecovery.worktree_path || deliveryRecovery.canonical_repo_path || process.cwd();
  for (const candidate of candidates) {
    if (!isValidCommitCandidate(candidate)) continue;
    if (isCommitAncestorOfHead(candidate, repoPath)) return candidate.trim();
  }
  return null;
}

function isVerifiedReadOnlyResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(result.changed_files) || result.changed_files.length !== 0) return false;
  if (!(result.verification?.passed === true || hasStringEvidence(result.tests))) return false;
  const text = [result.summary, result.tests, result.status, result.kind]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /readonly|read-only/.test(text);
}

function hasActionableReviewEvidence(result, resultShape) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true;
  if (Object.keys(result).length === 0) return false;
  if ([RESULT_SHAPE_TYPES.CODE_EVIDENCE, RESULT_SHAPE_TYPES.COMPLETION_EVIDENCE, RESULT_SHAPE_TYPES.FAILURE_EVIDENCE].includes(resultShape)) return true;
  return hasStringEvidence(result.summary)
    || hasStringEvidence(result.status)
    || hasStringEvidence(result.kind)
    || Array.isArray(result.acceptance_findings)
    || Boolean(result.reviewer_decision);
}

function decision(label, status, resultShape, blocksCurrentWork) {
  return {
    label,
    status,
    result_shape: resultShape,
    blocks_current_work: blocksCurrentWork,
  };
}

/**
 * Check if a commit is an ancestor of the current HEAD in a git repo.
 * Uses `git merge-base --is-ancestor` for the check. Returns false if the
 * commit does not exist or is not reachable from HEAD, or if the git command
 * fails (e.g., no git repo, commit not found).
 */
export function isCommitAncestorOfHead(commit, repoPath) {
  if (!commit || typeof commit !== 'string' || commit.trim().length === 0) return false;
  const safeCommit = commit.trim();
  if (safeCommit.length < 7) return false;
  const candidates = [];
  if (repoPath && existsSync(repoPath)) candidates.push(resolve(repoPath));
  if (process.env.GPTWORK_DEFAULT_REPO_PATH && existsSync(process.env.GPTWORK_DEFAULT_REPO_PATH)) {
    candidates.push(resolve(process.env.GPTWORK_DEFAULT_REPO_PATH));
  }
  candidates.push(process.cwd());

  for (const cwd of [...new Set(candidates)]) {
    try {
      execSync("git merge-base --is-ancestor " + safeCommit + " HEAD 2>/dev/null", { cwd, stdio: 'ignore', timeout: 5_000 });
      return true;
    } catch {}
  }
  return false;
}
