/**
 * delivery-contracts.mjs — Unified delivery contract constants, state machine,
 * and validation helpers shared across the delivery pipeline.
 *
 * Governs the full task lifecycle, goal/task/result contracts, and
 * state transitions for the multi-task delivery system.
 *
 * Every module in the pipeline imports from here — parser, finalizer,
 * acceptance agent, integration queue — ensuring a single source of truth.
 */

// ---------------------------------------------------------------------------
// Task lifecycle states
// ---------------------------------------------------------------------------

export const TASK_STATUS = {
  /** Task record created but not yet queued */
  CREATED: 'created',
  /** Task enqueued in the execution queue */
  QUEUED: 'queued',
  /** Waiting for a dependency (another task or goal) to complete */
  WAITING_FOR_DEPENDENCY: 'waiting_for_dependency',
  /** Waiting for repo/execution lock to be released */
  WAITING_FOR_LOCK: 'waiting_for_lock',
  /** Git worktree is being created */
  MATERIALIZING_WORKTREE: 'materializing_worktree',
  /** Task assigned to a worker */
  ASSIGNED: 'assigned',
  /** Task is being executed by Codex worker */
  RUNNING: 'running',
  /** Task result is being verified */
  VERIFYING: 'verifying',
  /** Verification/acceptance failed, waiting for automatic repair */
  WAITING_FOR_REPAIR: 'waiting_for_repair',
  /** Repair task is being executed */
  REPAIRING: 'repairing',
  /** Task passed acceptance, waiting for integration (merge) lock */
  WAITING_FOR_INTEGRATION: 'waiting_for_integration',
  /** Integration (merge/rebase/push) is in progress */
  INTEGRATING: 'integrating',
  /** Final state — task completed successfully through the full pipeline */
  COMPLETED: 'completed',
  /** Final state — task failed irrecoverably */
  FAILED: 'failed',
  /** Task requires human review (e.g., repair budget exceeded) */
  WAITING_FOR_REVIEW: 'waiting_for_review',
  /** Task was cancelled before completion */
  CANCELLED: 'cancelled',
  /** Task timed out during execution */
  TIMED_OUT: 'timed_out',
};

// ---------------------------------------------------------------------------
// State machine: legal transitions
// ---------------------------------------------------------------------------

/**
 * Map of legal source->target status transitions.
 * Multiple source states can map to multiple target states.
 */
export const LEGAL_TRANSITIONS = {
  [TASK_STATUS.CREATED]:                  [TASK_STATUS.QUEUED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.QUEUED]:                   [TASK_STATUS.WAITING_FOR_DEPENDENCY, TASK_STATUS.WAITING_FOR_LOCK, TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED],
  [TASK_STATUS.WAITING_FOR_DEPENDENCY]:   [TASK_STATUS.QUEUED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.WAITING_FOR_LOCK]:         [TASK_STATUS.QUEUED, TASK_STATUS.MATERIALIZING_WORKTREE, TASK_STATUS.CANCELLED],
  [TASK_STATUS.MATERIALIZING_WORKTREE]:   [TASK_STATUS.RUNNING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.ASSIGNED]:                 [TASK_STATUS.RUNNING, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.RUNNING]:                  [TASK_STATUS.VERIFYING, TASK_STATUS.FAILED, TASK_STATUS.WAITING_FOR_REVIEW, TASK_STATUS.TIMED_OUT],
  [TASK_STATUS.VERIFYING]:                [TASK_STATUS.WAITING_FOR_REPAIR, TASK_STATUS.WAITING_FOR_INTEGRATION, TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.WAITING_FOR_REVIEW],
  [TASK_STATUS.WAITING_FOR_REPAIR]:       [TASK_STATUS.REPAIRING, TASK_STATUS.WAITING_FOR_REVIEW, TASK_STATUS.CANCELLED],
  [TASK_STATUS.REPAIRING]:                [TASK_STATUS.VERIFYING, TASK_STATUS.WAITING_FOR_REVIEW, TASK_STATUS.FAILED],
  [TASK_STATUS.WAITING_FOR_INTEGRATION]:  [TASK_STATUS.INTEGRATING, TASK_STATUS.FAILED, TASK_STATUS.WAITING_FOR_REVIEW],
  [TASK_STATUS.INTEGRATING]:              [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.WAITING_FOR_REVIEW],
  [TASK_STATUS.COMPLETED]:                [],  // terminal
  [TASK_STATUS.FAILED]:                   [],  // terminal
  [TASK_STATUS.WAITING_FOR_REVIEW]:       [],  // terminal (human intervention)
  [TASK_STATUS.CANCELLED]:                [],  // terminal
  [TASK_STATUS.TIMED_OUT]:                [],  // terminal
};

/** Statuses considered terminal — task will not auto-transition further */
export const TERMINAL_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.WAITING_FOR_REVIEW,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.TIMED_OUT,
]);

/** Statuses considered "active" — task is in progress */
export const ACTIVE_STATUSES = new Set([
  TASK_STATUS.QUEUED,
  TASK_STATUS.WAITING_FOR_DEPENDENCY,
  TASK_STATUS.WAITING_FOR_LOCK,
  TASK_STATUS.MATERIALIZING_WORKTREE,
  TASK_STATUS.ASSIGNED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.VERIFYING,
  TASK_STATUS.WAITING_FOR_REPAIR,
  TASK_STATUS.REPAIRING,
  TASK_STATUS.WAITING_FOR_INTEGRATION,
  TASK_STATUS.INTEGRATING,
]);

// ---------------------------------------------------------------------------
// State transition validation
// ---------------------------------------------------------------------------

/**
 * Validate a state transition.
 *
 * @param {string} from - Current task status
 * @param {string} to - Desired target status
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTaskStateTransition(from, to) {
  if (!from || !to) {
    return { valid: false, reason: 'Source and target status must be non-empty' };
  }
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed) {
    return { valid: false, reason: `Unknown source status: "${from}"` };
  }
  if (TERMINAL_STATUSES.has(from)) {
    return { valid: false, reason: `Cannot transition from terminal status "${from}"` };
  }
  if (allowed.includes(to)) {
    return { valid: true };
  }
  return { valid: false, reason: `Transition "${from}" → "${to}" is not allowed` };
}

// ---------------------------------------------------------------------------
// Delivery contract validation
// ---------------------------------------------------------------------------

/**
 * Validate a task record against the minimum delivery contract.
 *
 * Required fields:
 *  - task MUST bind to a goal_id
 *  - If task has a result, running task MUST have repo resolution
 *  - If worktree is enabled, MUST have worktree_lifecycle metadata
 *  - completed tasks MUST have verification/reviewer_decision
 *  - changed_files (non-empty) MUST have commit or patch evidence
 *
 * @param {object} task - Task record
 * @returns {{ valid: boolean, findings: Array<{ severity: string, code: string, message: string }> }}
 */
export function validateDeliveryContract(task = {}) {
  const findings = [];

  if (!task.goal_id) {
    findings.push({
      severity: 'blocker',
      code: 'goal_id_missing',
      message: 'Task must bind to a goal_id',
    });
  }

  if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.VERIFYING) {
    if (!task.repo_resolution && !task.repo_id) {
      findings.push({
        severity: 'blocker',
        code: 'repo_resolution_missing',
        message: 'Running/verifying task must have repo resolution or repo_id',
      });
    }
  }

  if (task.worktree_enabled === true) {
    if (!task.worktree_lifecycle || typeof task.worktree_lifecycle !== 'object') {
      findings.push({
        severity: 'blocker',
        code: 'worktree_lifecycle_missing',
        message: 'Worktree-enabled task must have worktree_lifecycle metadata',
      });
    }
  }

  if (task.status === TASK_STATUS.COMPLETED) {
    if (!task.reviewer_decision && !task.acceptance_findings) {
      findings.push({
        severity: 'blocker',
        code: 'acceptance_decision_missing',
        message: 'Completed task must have acceptance findings or reviewer decision',
      });
    }
  }

  if (Array.isArray(task.changed_files) && task.changed_files.length > 0) {
    if (!task.commit && !task.patch_evidence) {
      findings.push({
        severity: 'major',
        code: 'changed_files_missing_evidence',
        message: 'Tasks with changed_files must have commit or patch evidence',
      });
    }
  }

  return {
    valid: findings.length === 0,
    findings,
  };
}

const LEGACY_STATUS_MAP = {
  open: TASK_STATUS.QUEUED,
  pending: TASK_STATUS.QUEUED,
  queued: TASK_STATUS.QUEUED,
  assigned: TASK_STATUS.ASSIGNED,
  in_progress: TASK_STATUS.RUNNING,
  processing: TASK_STATUS.RUNNING,
  running: TASK_STATUS.RUNNING,
  blocked: TASK_STATUS.WAITING_FOR_REVIEW,
  needs_review: TASK_STATUS.WAITING_FOR_REVIEW,
  done: TASK_STATUS.COMPLETED,
  success: TASK_STATUS.COMPLETED,
  completed: TASK_STATUS.COMPLETED,
  error: TASK_STATUS.FAILED,
  failed: TASK_STATUS.FAILED,
};

/**
 * Return a delivery-contract-shaped copy of a legacy task record.
 *
 * Older GPTWork tasks often stored lifecycle evidence under result.* and used
 * goalId/status aliases. This adapter lets release checks and queue/status
 * consumers validate old tasks without rewriting historical state in place.
 *
 * @param {object} task
 * @returns {object}
 */
export function normalizeLegacyTaskForDelivery(task = {}) {
  const result = task.result && typeof task.result === 'object' ? task.result : {};
  const status = String(task.status || result.status || '').toLowerCase();
  const normalized = {
    ...task,
    goal_id: task.goal_id || task.goalId || result.goal_id || result.goalId,
    status: LEGACY_STATUS_MAP[status] || task.status || TASK_STATUS.CREATED,
  };

  for (const key of [
    'tests',
    'verification',
    'reviewer_decision',
    'acceptance_findings',
    'commit',
    'remote_head',
    'changed_files',
    'patch_evidence',
  ]) {
    if (normalized[key] === undefined && result[key] !== undefined) normalized[key] = result[key];
  }

  if (normalized.reviewer_decision === undefined && result.reviewerDecision !== undefined) {
    normalized.reviewer_decision = result.reviewerDecision;
  }
  if (normalized.acceptance_findings === undefined && result.acceptanceFindings !== undefined) {
    normalized.acceptance_findings = result.acceptanceFindings;
  }
  if (normalized.changed_files === undefined && result.changedFiles !== undefined) {
    normalized.changed_files = result.changedFiles;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Queue status mapping (delivery states ↔ queue states)
// ---------------------------------------------------------------------------

/**
 * Map a delivery TASK_STATUS to its corresponding queue status.
 * Queue uses simplified states: waiting, ready, running, blocked, completed, failed, cancelled.
 */
export function taskStatusToQueueStatus(taskStatus) {
  switch (taskStatus) {
    case TASK_STATUS.CREATED:
    case TASK_STATUS.QUEUED:
      return 'waiting';
    case TASK_STATUS.WAITING_FOR_DEPENDENCY:
      return 'blocked';
    case TASK_STATUS.WAITING_FOR_LOCK:
      return 'blocked';
    case TASK_STATUS.MATERIALIZING_WORKTREE:
    case TASK_STATUS.ASSIGNED:
    case TASK_STATUS.RUNNING:
    case TASK_STATUS.VERIFYING:
    case TASK_STATUS.REPAIRING:
    case TASK_STATUS.INTEGRATING:
      return 'running';
    case TASK_STATUS.WAITING_FOR_REPAIR:
    case TASK_STATUS.WAITING_FOR_INTEGRATION:
      return 'ready';
    case TASK_STATUS.COMPLETED:
      return 'completed';
    case TASK_STATUS.FAILED:
      return 'failed';
    case TASK_STATUS.WAITING_FOR_REVIEW:
      return 'blocked';
    case TASK_STATUS.CANCELLED:
      return 'cancelled';
    default:
      return 'waiting';
  }
}

// ---------------------------------------------------------------------------
// Acceptance profile mapping
// ---------------------------------------------------------------------------

export const ACCEPTANCE_PROFILES = {
  DEFAULT: 'default',
  CODE_CHANGE: 'code_change',
  DOCS_ONLY: 'docs_only',
  CONFIG_CHANGE: 'config_change',
  DEPLOY: 'deploy',
  NOOP: 'noop',
};

/**
 * Infer the acceptance profile from a task's mode and changed files.
 *
 * @param {object} task
 * @returns {string} Profile name
 */
export function inferAcceptanceProfile(task = {}) {
  const operationKind = task.operation_kind || task.acceptance_contract?.intent?.operation_kind || task.acceptance_contract?.operation_kind || "code_change";
  if (operationKind === 'deploy') return ACCEPTANCE_PROFILES.DEPLOY;
  if (task.noop === true || operationKind === 'noop') return ACCEPTANCE_PROFILES.NOOP;

  const changed = Array.isArray(task.changed_files) ? task.changed_files : [];
  const allDocs = changed.length > 0 && changed.every((f) =>
    f.startsWith('docs/') || f.endsWith('.md') || f.endsWith('.txt')
  );
  if (allDocs) return ACCEPTANCE_PROFILES.DOCS_ONLY;

  const allConfig = changed.length > 0 && changed.every((f) =>
    f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.env') || f.endsWith('.toml')
  );
  if (allConfig) return ACCEPTANCE_PROFILES.CONFIG_CHANGE;

  if (changed.length > 0) return ACCEPTANCE_PROFILES.CODE_CHANGE;
  return ACCEPTANCE_PROFILES.DEFAULT;
}

// ---------------------------------------------------------------------------
// Named export aliases for compatibility
// ---------------------------------------------------------------------------

export const DELIVERY_STATE_CREATED = TASK_STATUS.CREATED;
export const DELIVERY_STATE_QUEUED = TASK_STATUS.QUEUED;
export const DELIVERY_STATE_RUNNING = TASK_STATUS.RUNNING;
export const DELIVERY_STATE_COMPLETED = TASK_STATUS.COMPLETED;
export const DELIVERY_STATE_FAILED = TASK_STATUS.FAILED;
export const DELIVERY_STATE_CANCELLED = TASK_STATUS.CANCELLED;
