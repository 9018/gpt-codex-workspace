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
  isHumanReviewStatus,
  isTypedReviewStatus,
  isMachineRepairableReviewState,
  normalizeTaskStatus,
} from './task-status-taxonomy.mjs';

// P0-MA22: No-mutation task profiles — changed_files=[] is a valid terminal.
const NO_MUTATION_PROFILES = new Set([
  'diagnostic', 'noop', 'readonly_validation', 'already_integrated',
  'repair_noop', 'network_retry', 'verification_only', 'sync_only',
  'github_sync_only',
]);

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
  // P0-MA20: Accept result.tests as standalone verification evidence.
  // Codex runs may produce tests text without populating verification.commands
  // or contract_verification. Treat non-empty tests as verification evidence
  // for non-commit-bearing results.
  //
  // P0-UA6: Commit-bearing results must validate commit reachability BEFORE
  // considering tests alone as normalization evidence.  Tests text alone must
  // not normalize commit-bearing legacy results — if the commit is not reachable
  // from HEAD, the task still has a genuine blocking issue even if tests appear
  // to pass.  When the commit IS reachable AND verification/tests evidence is
  // present, populate delivery_result_recovery so downstream consumers do not
  // block on stale review state.
  if (isValidCommitCandidate(result.commit)) {
    const integratedCommit = getVerifiedIntegratedCommitCandidate(result);
    if (integratedCommit) {
      result.delivery_result_recovery = result.delivery_result_recovery || {};
      result.delivery_result_recovery.reason = 'already_integrated';
      result.delivery_result_recovery.recovered = true;
      result.delivery_result_recovery.commit = integratedCommit;
      result.delivery_result_recovery.commit_integrated = true;
      return true;
    }
    return false;
  }
  if (hasStringEvidence(result.tests)) return true;
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

  // P0-MA22: No-mutation profiles with passing verification are always normalized.
  // sync-only/verification-only tasks with changed_files=[] and passing verification
  // should not be treated as having actionable blockers or review states.
  // Only use explicit profile/kind markers -- generic flags like needs_integration
  // or closure_type are too broad for this classification.
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files : [];
  if (changedFiles.length === 0 && (result.verification?.passed === true || result.tests)) {
    const isNoMutation = NO_MUTATION_PROFILES.has(result.operation_kind)
      || NO_MUTATION_PROFILES.has(result.acceptance_profile)
      || NO_MUTATION_PROFILES.has(result.acceptance_contract?.intent?.operation_kind)
      || result.mutation_scope === 'none';
    if (isNoMutation) return true;
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
  if (isRecoveredResultMissingVerifiedCommit(result)) return decision(CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS, status, resultShape, false);
  if (isNoMutationProviderNoise(result)) return decision(CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY, status, resultShape, false);

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
  // P0-03: Typed review states — machine-repairable states do not block current work;
  // human-required states (WAITING_FOR_HUMAN_REQUIRED, WAITING_FOR_HUMAN_REVIEW,
  // WAITING_FOR_MANUAL_TERMINAL_DECISION, WAITING_FOR_REPAIR_BUDGET_EXHAUSTED) do block.
  if (isHumanReviewStatus(status) || isTypedReviewStatus(status)) {
    if (status === TASK_STATUSES.WAITING_FOR_REVIEW) {
      // Already handled above — skip
    } else {
      const machineRepairable = isMachineRepairableReviewState(status);
      return decision(CURRENT_WORK_DECISION_LABELS.REVIEW, status, resultShape, !machineRepairable);
    }
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

function isRecoveredResultMissingVerifiedCommit(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const deliveryRecovery = result.delivery_result_recovery || result.delivery_recovery || {};
  if (deliveryRecovery.reason !== 'result_missing_but_verified_commit') return false;
  const candidates = [deliveryRecovery.commit, deliveryRecovery.local_head];
  const repoPath = result.execution_cwd || deliveryRecovery.worktree_path || deliveryRecovery.canonical_repo_path || process.cwd();
  return candidates.some((candidate) => isValidCommitCandidate(candidate) && isCommitAncestorOfHead(candidate, repoPath));
}

function isNoMutationProviderNoise(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files : [];
  const deliveryRecovery = result.delivery_result_recovery || result.delivery_recovery || {};
  const deliveryChangedFiles = Array.isArray(deliveryRecovery.changed_files) ? deliveryRecovery.changed_files : [];
  if (changedFiles.length > 0 || deliveryChangedFiles.length > 0) return false;
  if (hasVerificationEvidence(result)) return false;
  if (isValidCommitCandidate(result.commit) || isValidCommitCandidate(deliveryRecovery.commit)) return false;
  const findings = Array.isArray(result.acceptance_findings) ? result.acceptance_findings : [];
  const codes = findings.map((finding) => String(finding?.code || '').trim()).filter(Boolean);
  const allowedCodes = new Set([
    'codex_failed',
    'delivery_result_recovery_failed',
    'git_worktree_lifecycle_metadata_only',
  ]);
  if (codes.length > 0 && !codes.every((code) => allowedCodes.has(code))) return false;
  const reason = String(deliveryRecovery.reason || '').trim();
  const allowedReasons = new Set(['', 'no_changed_files', 'canonical_dirty']);
  if (!allowedReasons.has(reason)) return false;
  const summary = String(result.summary || result.kind || result.failure_class || '').toLowerCase();
  return summary.includes('codex') || summary.includes('no-op') || codes.length > 0 || reason.length > 0;
}

function isVerifiedReadOnlyResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(result.changed_files) || result.changed_files.length !== 0) return false;
  if (!(result.verification?.passed === true || hasStringEvidence(result.tests))) return false;
  // P0-MA22: Also match no-mutation profiles (sync_only, verification_only, etc.)
  const text = [result.summary, result.tests, result.status, result.kind]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/readonly|read-only/.test(text)) return true;
  if (NO_MUTATION_PROFILES.has(result.operation_kind)) return true;
  if (NO_MUTATION_PROFILES.has(result.acceptance_profile)) return true;
  if (result.mutation_scope === 'none') return true;
  return false;
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
