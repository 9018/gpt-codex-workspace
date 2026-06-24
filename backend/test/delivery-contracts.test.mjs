import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATUS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  validateTaskStateTransition,
  validateDeliveryContract,
  taskStatusToQueueStatus,
  inferAcceptanceProfile,
  ACCEPTANCE_PROFILES,
} from '../src/delivery-contracts.mjs';

describe('TASK_STATUS constants', () => {
  it('should define all expected statuses', () => {
    const expected = [
      'CREATED', 'QUEUED', 'WAITING_FOR_DEPENDENCY', 'WAITING_FOR_LOCK',
      'MATERIALIZING_WORKTREE', 'ASSIGNED', 'RUNNING', 'VERIFYING',
      'WAITING_FOR_REPAIR', 'REPAIRING', 'WAITING_FOR_INTEGRATION',
      'INTEGRATING', 'COMPLETED', 'FAILED', 'WAITING_FOR_REVIEW', 'CANCELLED', 'TIMED_OUT',
    ];
    for (const key of expected) {
      assert.ok(key in TASK_STATUS, `Missing TASK_STATUS.${key}`);
    }
  });

  it('should have unique status values', () => {
    const values = Object.values(TASK_STATUS);
    assert.equal(values.length, new Set(values).size);
  });

  it('should have terminal and active status disjoint', () => {
    for (const s of TERMINAL_STATUSES) {
      assert.ok(!ACTIVE_STATUSES.has(s), `${s} should not be both terminal and active`);
    }
  });
});

describe('validateTaskStateTransition', () => {
  it('should allow legal transition: created -> queued', () => {
    const result = validateTaskStateTransition(TASK_STATUS.CREATED, TASK_STATUS.QUEUED);
    assert.ok(result.valid);
  });

  it('should reject transition from terminal status', () => {
    const result = validateTaskStateTransition(TASK_STATUS.COMPLETED, TASK_STATUS.RUNNING);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('terminal'));
  });

  it('should reject unknown source status', () => {
    const result = validateTaskStateTransition('nonexistent', TASK_STATUS.RUNNING);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('Unknown'));
  });

  it('should reject empty source or target', () => {
    assert.equal(validateTaskStateTransition('', TASK_STATUS.RUNNING).valid, false);
    assert.equal(validateTaskStateTransition(TASK_STATUS.CREATED, '').valid, false);
  });

  it('should reject illegal transition: running -> completed (must go through verifying)', () => {
    const result = validateTaskStateTransition(TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED);
    assert.equal(result.valid, false);
  });

  it('should allow: verifying -> waiting_for_integration', () => {
    const result = validateTaskStateTransition(TASK_STATUS.VERIFYING, TASK_STATUS.WAITING_FOR_INTEGRATION);
    assert.ok(result.valid);
  });

  it('should allow: waiting_for_repair -> repairing', () => {
    const result = validateTaskStateTransition(TASK_STATUS.WAITING_FOR_REPAIR, TASK_STATUS.REPAIRING);
    assert.ok(result.valid);
  });

  it('should allow: integrating -> completed', () => {
    const result = validateTaskStateTransition(TASK_STATUS.INTEGRATING, TASK_STATUS.COMPLETED);
    assert.ok(result.valid);
  });

  it('should allow all legal transitions from VERIFYING', () => {
    const targets = [
      TASK_STATUS.WAITING_FOR_REPAIR,
      TASK_STATUS.WAITING_FOR_INTEGRATION,
      TASK_STATUS.COMPLETED,
      TASK_STATUS.FAILED,
      TASK_STATUS.WAITING_FOR_REVIEW,
    ];
    for (const target of targets) {
      assert.ok(validateTaskStateTransition(TASK_STATUS.VERIFYING, target).valid,
        `Expected VERIFYING -> ${target} to be legal`);
    }
  });
});

describe('validateDeliveryContract', () => {
  it('should pass for a valid completed task', () => {
    const task = {
      goal_id: 'goal-1',
      status: TASK_STATUS.COMPLETED,
      acceptance_findings: [],
      changed_files: ['src/foo.mjs'],
      commit: 'abc123',
    };
    assert.ok(validateDeliveryContract(task).valid);
  });

  it('should fail when goal_id is missing', () => {
    const result = validateDeliveryContract({ status: TASK_STATUS.CREATED });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => f.code === 'goal_id_missing'));
  });

  it('should fail when running task has no repo resolution', () => {
    const result = validateDeliveryContract({ goal_id: 'g1', status: TASK_STATUS.RUNNING });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => f.code === 'repo_resolution_missing'));
  });

  it('should pass when running task has repo_id', () => {
    const result = validateDeliveryContract({ goal_id: 'g1', status: TASK_STATUS.RUNNING, repo_id: 'repo-1' });
    assert.ok(result.valid);
  });

  it('should fail when worktree_enabled has no lifecycle', () => {
    const result = validateDeliveryContract({ goal_id: 'g1', status: TASK_STATUS.RUNNING, worktree_enabled: true });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => f.code === 'worktree_lifecycle_missing'));
  });

  it('should fail when completed has no acceptance decision', () => {
    const result = validateDeliveryContract({ goal_id: 'g1', status: TASK_STATUS.COMPLETED });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => f.code === 'acceptance_decision_missing'));
  });

  it('should fail when changed_files has no commit or patch evidence', () => {
    const result = validateDeliveryContract({
      goal_id: 'g1',
      status: TASK_STATUS.COMPLETED,
      acceptance_findings: [],
      changed_files: ['src/foo.mjs'],
    });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => f.code === 'changed_files_missing_evidence'));
  });

  it('should pass for minimal created task', () => {
    const result = validateDeliveryContract({ goal_id: 'g1', status: TASK_STATUS.CREATED });
    assert.ok(result.valid);
  });
});

describe('taskStatusToQueueStatus', () => {
  it('should map created/queued to waiting', () => {
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.CREATED), 'waiting');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.QUEUED), 'waiting');
  });

  it('should map waiting_for_dependency/lock to blocked', () => {
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.WAITING_FOR_DEPENDENCY), 'blocked');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.WAITING_FOR_LOCK), 'blocked');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.WAITING_FOR_REVIEW), 'blocked');
  });

  it('should map active execution states to running', () => {
    const runningStates = [
      TASK_STATUS.MATERIALIZING_WORKTREE, TASK_STATUS.ASSIGNED,
      TASK_STATUS.RUNNING, TASK_STATUS.VERIFYING,
      TASK_STATUS.REPAIRING, TASK_STATUS.INTEGRATING,
    ];
    for (const s of runningStates) {
      assert.equal(taskStatusToQueueStatus(s), 'running', `${s} -> running`);
    }
  });

  it('should map completed/failed/cancelled directly', () => {
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.COMPLETED), 'completed');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.FAILED), 'failed');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.CANCELLED), 'cancelled');
  });

  it('should map waiting_for_repair/integration to ready', () => {
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.WAITING_FOR_REPAIR), 'ready');
    assert.equal(taskStatusToQueueStatus(TASK_STATUS.WAITING_FOR_INTEGRATION), 'ready');
  });
});

describe('inferAcceptanceProfile', () => {
  it('should return deploy for deploy mode', () => {
    assert.equal(inferAcceptanceProfile({ mode: 'deploy' }), ACCEPTANCE_PROFILES.DEPLOY);
  });

  it('should return noop for noop tasks', () => {
    assert.equal(inferAcceptanceProfile({ noop: true }), ACCEPTANCE_PROFILES.NOOP);
    assert.equal(inferAcceptanceProfile({ mode: 'noop' }), ACCEPTANCE_PROFILES.NOOP);
  });

  it('should return docs_only when all changed files are docs', () => {
    const result = inferAcceptanceProfile({ changed_files: ['docs/readme.md', 'docs/guide.txt'] });
    assert.equal(result, ACCEPTANCE_PROFILES.DOCS_ONLY);
  });

  it('should return config_change when all files are config', () => {
    const result = inferAcceptanceProfile({ changed_files: ['config.json', 'settings.yaml'] });
    assert.equal(result, ACCEPTANCE_PROFILES.CONFIG_CHANGE);
  });

  it('should return code_change for source changes', () => {
    const result = inferAcceptanceProfile({ changed_files: ['src/foo.mjs'] });
    assert.equal(result, ACCEPTANCE_PROFILES.CODE_CHANGE);
  });

  it('should return default for no changed files', () => {
    assert.equal(inferAcceptanceProfile({}), ACCEPTANCE_PROFILES.DEFAULT);
  });
});
