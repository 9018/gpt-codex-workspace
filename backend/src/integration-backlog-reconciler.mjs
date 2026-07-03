/**
 * integration-backlog-reconciler.mjs — Integration Backlog Reconciler
 *
 * P0-MA7: Scans waiting_for_integration tasks and reconciles their state
 * against current canonical-repo evidence.  Produces typed reconciliation
 * results that identify tasks whose result commit is already on main and
 * whose acceptance is satisfied, marks integration/finalizer/queue evidence
 * consistently, and keeps genuine unresolved integration problems as typed
 * blockers.
 *
 * Reconciliation types:
 *   already_integrated_and_accepted   — Commit is on main and acceptance is
 *                                       satisfied; task can be completed.
 *   already_integrated_no_acceptance  — Commit is on main but acceptance not
 *                                       satisfied; typed blocker for acceptance.
 *   commit_not_on_main                — Genuine waiting_for_integration; commit
 *                                       has not reached main yet.
 *   commit_missing                    — No commit evidence on the task result.
 *   acceptance_not_satisfied          — Acceptance criteria not met.
 *   integration_not_needed            — Operation kind is noop-like, integration
 *                                       requirement was misapplied.
 *   repairable_integration_failure    — Integration attempt failed in a
 *                                       repairable way (conflict, check_failed).
 *   waiting_for_external_integration  — Branch pushed / PR opened, waiting
 *                                       for external CI/merge.
 *   still_waiting_for_integration     — Default typed-blocker classification
 *                                       when no other classification applies.
 *
 * @module integration-backlog-reconciler
 */

import { execFileSync } from 'node:child_process';
import {
  TASK_STATUSES,
  normalizeTaskStatus,
} from './task-status-taxonomy.mjs';
import { isIntegrationRepairableStatus } from './auto-integration-completion.mjs';
import { writeIntegratorAgentRun } from './agent-run-writeback.mjs';

// ---------------------------------------------------------------------------
// Reconciliation type constants
// ---------------------------------------------------------------------------

export const INTEGRATION_RECONCILIATION_TYPES = Object.freeze({
  ALREADY_INTEGRATED_AND_ACCEPTED: 'already_integrated_and_accepted',
  ALREADY_INTEGRATED_NO_ACCEPTANCE: 'already_integrated_no_acceptance',
  COMMIT_NOT_ON_MAIN: 'commit_not_on_main',
  COMMIT_MISSING: 'commit_missing',
  ACCEPTANCE_NOT_SATISFIED: 'acceptance_not_satisfied',
  INTEGRATION_NOT_NEEDED: 'integration_not_needed',
  REPAIRABLE_INTEGRATION_FAILURE: 'repairable_integration_failure',
  WAITING_FOR_EXTERNAL_INTEGRATION: 'waiting_for_external_integration',
  STILL_WAITING_FOR_INTEGRATION: 'still_waiting_for_integration',
});

/** Task statuses that indicate external integration is in progress. */
const EXTERNAL_INTEGRATION_STATUSES = new Set([
  'branch_pushed',
  'pr_opened',
  'pending',
  'queued',
  'waiting',
]);

/** Noop-like operation kinds that do not require integration. */
const NOOP_LIKE_OPERATION_KINDS = new Set([
  'noop',
  'readonly_validation',
  'diagnostic',
  'already_integrated',
  'sync_only',
  'verification_only',
]);

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Check if a commit is an ancestor of the current HEAD (i.e., already on main).
 */
export function isCommitOnMain(repoPath, commitSha) {
  if (!repoPath || !commitSha) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a commit exists as a known object in the repository.
 */
export function commitExistsInRepo(repoPath, commitSha) {
  if (!repoPath || !commitSha) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Acceptance helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a task's acceptance (reviewer decision) is satisfied.
 */
export function acceptanceSatisfied(result = {}) {
  const acceptance = result.acceptance_gate || result.acceptance || {};
  const reviewer = result.reviewer_decision || {};
  if (acceptance.passed === true || acceptance.status === 'accepted') return true;
  if (reviewer.passed === true || reviewer.decision === 'accepted') return true;
  if (reviewer.decision?.passed === true || reviewer.decision?.status === 'accepted') return true;

  if (result.verification?.passed === true) {
    const findings = [
      ...(Array.isArray(result.acceptance_findings) ? result.acceptance_findings : []),
      ...(Array.isArray(result.findings) ? result.findings : []),
      ...(Array.isArray(result.verification?.findings) ? result.verification.findings : []),
    ];
    const blockers = findings.filter(
      (f) => (f?.severity === 'blocker' || f?.severity === 'major') && f?.resolved !== true
    );
    if (blockers.length === 0) return true;
  }
  return false;
}

/**
 * Extract the commit SHA from a task's result.
 */
export function extractCommit(result = {}) {
  return result.commit || result.local_head || result.repo_head || null;
}

/**
 * Check whether a task's operation kind indicates integration is not required.
 */
export function integrationNotRequired(result = {}) {
  if (result.integration_not_required === true) return true;
  if (result.needs_integration === false) return true;
  if (result.integration?.required === false) return true;
  if (result.noop_result === true || result.readonly_result === true) return true;
  if (result.operation_kind && NOOP_LIKE_OPERATION_KINDS.has(result.operation_kind)) return true;
  return false;
}

/**
 * Check if a task's integration result shows an external integration status
 * (branch_pushed, pr_opened) that is waiting for external completion.
 */
export function isExternalIntegrationWait(result = {}) {
  const integration = result.integration || {};
  const status = String(integration.status || '').toLowerCase();
  if (EXTERNAL_INTEGRATION_STATUSES.has(status) && integration.ok !== false) return true;
  if (result.integration_terminalization?.status === 'waiting_for_external_integration') return true;
  if (result.integration_retry_state?.stable_wait_reason === 'branch_pushed_requires_external_integration') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify the integration state of a single task based on its result and
 * canonical repo evidence.
 */
export function classifyIntegrationState({ task = {}, result = null, canonicalRepoPath = null } = {}) {
  const taskResult = result || task.result || {};
  const commit = extractCommit(taskResult);
  const integration = taskResult.integration || {};
  const integrationStatus = String(integration.status || '').toLowerCase();

  // ---- Check 0: Integration not required (noop-like) ----
  if (integrationNotRequired(taskResult)) {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.INTEGRATION_NOT_NEEDED,
      commit,
      commit_on_main: null,
      acceptance_satisfied: acceptanceSatisfied(taskResult),
      integration_not_required: true,
      external_wait: false,
      repairable: false,
      reason: 'Task operation kind does not require integration',
      evidence: {
        operation_kind: taskResult.operation_kind,
        integration_not_required: true,
        noop_result: taskResult.noop_result,
        readonly_result: taskResult.readonly_result,
      },
    };
  }

  // ---- Check 1: External integration wait (branch_pushed, pr_opened) ----
  if (isExternalIntegrationWait(taskResult)) {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.WAITING_FOR_EXTERNAL_INTEGRATION,
      commit,
      commit_on_main: null,
      acceptance_satisfied: acceptanceSatisfied(taskResult),
      integration_not_required: false,
      external_wait: true,
      repairable: false,
      reason: `Integration status is "${integrationStatus}" — waiting for external merge or PR completion`,
      evidence: {
        integration_status: integrationStatus,
        integration_ok: integration.ok,
        terminalization: taskResult.integration_terminalization || null,
        retry_state: taskResult.integration_retry_state || null,
      },
    };
  }

  // ---- Check 2: Repairable integration failure ----
  if (isIntegrationRepairableStatus(integrationStatus)) {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.REPAIRABLE_INTEGRATION_FAILURE,
      commit,
      commit_on_main: null,
      acceptance_satisfied: acceptanceSatisfied(taskResult),
      integration_not_required: false,
      external_wait: false,
      repairable: true,
      reason: `Integration status is "${integrationStatus}" — repairable via integration recovery`,
      evidence: {
        integration_status: integrationStatus,
        integration_error: integration.error || null,
        conflict_files: integration.conflict_files || null,
        repairable: true,
      },
    };
  }

  // ---- Check 3: No commit evidence ----
  if (!commit || commit === 'none') {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.COMMIT_MISSING,
      commit: null,
      commit_on_main: null,
      acceptance_satisfied: acceptanceSatisfied(taskResult),
      integration_not_required: false,
      external_wait: false,
      repairable: false,
      reason: 'No commit evidence on task result',
      evidence: {
        has_commit: false,
        changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
      },
    };
  }

  // ---- Check 4: Commit on main check ----
  let commitOnMain = false;
  if (canonicalRepoPath) {
    try {
      commitOnMain = isCommitOnMain(canonicalRepoPath, commit);
    } catch {
      commitOnMain = false;
    }
  }

  const acceptanceOk = acceptanceSatisfied(taskResult);

  // ---- Check 5: Already integrated and accepted ----
  if (commitOnMain && acceptanceOk) {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED,
      commit,
      commit_on_main: true,
      acceptance_satisfied: true,
      integration_not_required: false,
      external_wait: false,
      repairable: false,
      reason: 'Commit is already on main and acceptance is satisfied — task can be completed',
      evidence: {
        commit,
        commit_on_main: true,
        acceptance_satisfied: true,
        canonical_repo_path: canonicalRepoPath,
      },
    };
  }

  // ---- Check 6: Already integrated but acceptance not satisfied ----
  if (commitOnMain && !acceptanceOk) {
    return {
      classification: INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_NO_ACCEPTANCE,
      commit,
      commit_on_main: true,
      acceptance_satisfied: false,
      integration_not_required: false,
      external_wait: false,
      repairable: false,
      reason: 'Commit is on main but acceptance is not satisfied — needs review or repair',
      evidence: {
        commit,
        commit_on_main: true,
        acceptance_satisfied: false,
        reviewer_decision: taskResult.reviewer_decision || null,
        acceptance_findings: Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [],
      },
    };
  }

  // ---- Default: Commit not on main ----
  return {
    classification: INTEGRATION_RECONCILIATION_TYPES.COMMIT_NOT_ON_MAIN,
    commit,
    commit_on_main: false,
    acceptance_satisfied: acceptanceOk,
    integration_not_required: false,
    external_wait: false,
    repairable: false,
    reason: `Commit ${commit.slice(0, 12)} is not yet on main — genuine waiting_for_integration`,
    evidence: {
      commit,
      commit_on_main: false,
      canonical_repo_path: canonicalRepoPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Single-task reconciler
// ---------------------------------------------------------------------------

/**
 * Reconcile a single task's integration state.
 */
export async function reconcileIntegrationTask({ task, state = {}, store = null, config = {} } = {}) {
  if (!task) {
    return { task_id: null, status: 'error', error: 'task is required', reconciled: false };
  }

  const result = task.result || {};
  const canonicalRepoPath = result.execution_cwd || config.defaultRepoPath || config.defaultWorkspaceRoot || null;
  const classification = classifyIntegrationState({ task, result, canonicalRepoPath });
  const reconciled = classification.classification === INTEGRATION_RECONCILIATION_TYPES.ALREADY_INTEGRATED_AND_ACCEPTED;

  const outcome = {
    task_id: task.id,
    goal_id: task.goal_id || null,
    task_status: normalizeTaskStatus(task.status),
    classification: classification.classification,
    reconciled,
    commit: classification.commit,
    commit_on_main: classification.commit_on_main,
    acceptance_satisfied: classification.acceptance_satisfied,
    integration_not_required: classification.integration_not_required,
    external_wait: classification.external_wait,
    repairable: classification.repairable,
    reason: classification.reason,
    evidence: classification.evidence,
    should_complete: reconciled,
    should_write_integrator_run: reconciled,
  };

  // ---- Write integrator agent_run for already-integrated tasks ----
  if (reconciled && store && typeof store.mutate === 'function') {
    try {
      const agentRunResult = await writeIntegratorAgentRun(store, {
        task_id: task.id,
        goal_id: task.goal_id || null,
        integrationResult: {
          status: 'merged',
          merged: true,
          commit: classification.commit,
          auto_completed: true,
          reconciled_by: 'integration_backlog_reconciler',
        },
      });
      outcome.integrator_agent_run = agentRunResult;
    } catch (err) {
      outcome.integrator_agent_run = { skipped: true, reason: err.message };
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Full backlog reconciler
// ---------------------------------------------------------------------------

/**
 * Scan all tasks and reconcile waiting_for_integration tasks.
 */
export async function reconcileIntegrationBacklog(store, config = {}) {
  if (!store || typeof store.load !== 'function') {
    return {
      scanned_at: new Date().toISOString(),
      error: 'store with load() function is required',
      total_scanned: 0,
      reconciled_count: 0,
      still_blocked_count: 0,
      tasks: [],
    };
  }

  const state = await store.load();
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const waitingTasks = tasks.filter(
    (t) => normalizeTaskStatus(t.status) === TASK_STATUSES.WAITING_FOR_INTEGRATION
  );

  if (waitingTasks.length === 0) {
    return {
      scanned_at: new Date().toISOString(),
      total_scanned: 0,
      reconciled_count: 0,
      still_blocked_count: 0,
      type_counts: {},
      tasks: [],
    };
  }

  const results = [];
  const reconciledTasks = [];
  const stillBlockedTasks = [];
  const typeCounts = {};

  for (const task of waitingTasks) {
    const result = await reconcileIntegrationTask({ task, state, store, config });
    results.push(result);
    typeCounts[result.classification] = (typeCounts[result.classification] || 0) + 1;
    if (result.reconciled) {
      reconciledTasks.push(result);
    } else {
      stillBlockedTasks.push(result);
    }
  }

  return {
    scanned_at: new Date().toISOString(),
    total_scanned: results.length,
    reconciled_count: reconciledTasks.length,
    still_blocked_count: stillBlockedTasks.length,
    type_counts: typeCounts,
    tasks: results,
  };
}

// ---------------------------------------------------------------------------
// Convenience: run full backlog reconcile from flat task array
// ---------------------------------------------------------------------------

/**
 * Run reconcileIntegrationBacklog against a flat array of tasks without
 * requiring a full StateStore instance.
 */
export async function runIntegrationBacklogReconcile(tasks, config = {}) {
  const adapterStore = {
    async load() {
      return { tasks: tasks || [] };
    },
  };
  return reconcileIntegrationBacklog(adapterStore, config);
}
