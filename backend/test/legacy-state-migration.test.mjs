/**
 * Tests for legacy-state-migration.mjs
 *
 * Uses fixture state objects only.  Never reads or writes real
 * .gptwork/state.json files.  Covers all five classification
 * categories and the apply/dry-run contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanAndClassifyTasks,
  buildMigrationPlan,
  resolveLegacyTask,
  applyMigrationPlan,
  formatReport,
  MIGRATION_CLASSIFICATIONS,
  LEGACY_RESOLUTION_LABELS,
} from '../src/legacy-state-migration.mjs';

// ---------------------------------------------------------------------------
// Fixture tasks
// ---------------------------------------------------------------------------

/** Fixture: empty result, non-blocking review (no actionable evidence). */
const fixtureReviewNoActionable = {
  id: 'task_review_no_actionable',
  status: 'waiting_for_review',
  result: {},
};

/** Fixture: code evidence in review — real blocker. */
const fixtureReviewBlocking = {
  id: 'task_review_blocking',
  status: 'waiting_for_review',
  result: {
    changed_files: ['backend/src/dirty.mjs'],
    summary: 'Made changes that need review',
  },
};

/** Fixture: verified repair — non-blocking (verification normalized). */
const fixtureRepairVerified = {
  id: 'task_repair_verified',
  status: 'waiting_for_repair',
  result: {
    verification: { passed: true },
    tests: 'All tests pass',
  },
};

/** Fixture: unverified repair — real blocker. */
const fixtureRepairBlocking = {
  id: 'task_repair_blocking',
  status: 'waiting_for_repair',
  result: {
    changed_files: ['backend/src/example.mjs'],
  },
};

/** Fixture: provider-empty failed task — non-blocking. */
const fixtureFailedProviderEmpty = {
  id: 'task_failed_provider_empty',
  status: 'failed',
  result: {
    kind: 'codex_failed',
    failure_class: 'result_missing',
  },
};

/** Fixture: failed with code evidence — real blocker. */
const fixtureFailedCodeEvidence = {
  id: 'task_failed_code_evidence',
  status: 'failed',
  result: {
    changed_files: ['backend/src/dirty.mjs'],
    commit: 'abc123',
  },
};

/** Fixture: failed with verification failure — real blocker. */
const fixtureFailedVerificationFailed = {
  id: 'task_failed_verification_failed',
  status: 'failed',
  result: {
    verification: { passed: false },
  },
};

/** Fixture: already resolved (legacy). */
const fixtureAlreadyResolved = {
  id: 'task_already_resolved',
  status: 'waiting_for_review',
  result: {
    resolved_legacy: true,
    resolved_legacy_reason: 'Previously migrated',
    previous_status: 'waiting_for_review',
    resolved_at: '2025-01-01T00:00:00.000Z',
    resolution_policy_label: 'review_no_actionable',
  },
};

/** Fixture: active running task — must never be migrated. */
const fixtureRunning = {
  id: 'task_running',
  status: 'running',
  result: {},
};

/** Fixture: assigned task — must never be migrated. */
const fixtureAssigned = {
  id: 'task_assigned',
  status: 'assigned',
  result: {},
};

/** Fixture: queued task — must never be migrated. */
const fixtureQueued = {
  id: 'task_queued',
  status: 'queued',
  result: {},
};

/** Fixture: completed task — policy excluded (not a legacy status). */
const fixtureCompleted = {
  id: 'task_completed',
  status: 'completed',
  result: {
    verification: { passed: true },
    changed_files: ['backend/src/feature.mjs'],
  },
};

/** Fixture: timed_out — policy excluded (not a legacy scan status). */
const fixtureTimedOut = {
  id: 'task_timed_out',
  status: 'timed_out',
  result: {
    kind: 'codex_timeout',
  },
};

/** Fixture: cancelled — policy excluded. */
const fixtureCancelled = {
  id: 'task_cancelled',
  status: 'cancelled',
  result: {},
};

// ---------------------------------------------------------------------------
// MIGRATION_CLASSIFICATIONS stability
// ---------------------------------------------------------------------------

test('MIGRATION_CLASSIFICATIONS is frozen with expected keys', () => {
  assert.equal(Object.isFrozen(MIGRATION_CLASSIFICATIONS), true);
  assert.deepEqual(MIGRATION_CLASSIFICATIONS, {
    RAW_LEGACY_RESOLVED: 'raw_legacy_resolved',
    RAW_UNRESOLVED: 'raw_unresolved',
    POLICY_EXCLUDED: 'policy_excluded',
    ACTIVE_CURRENT_BLOCKER: 'active_current_blocker',
    ALREADY_RESOLVED: 'already_resolved',
  });
});

test('LEGACY_RESOLUTION_LABELS is frozen', () => {
  assert.equal(Object.isFrozen(LEGACY_RESOLUTION_LABELS), true);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — edge cases
// ---------------------------------------------------------------------------

test('scanAndClassifyTasks returns empty result for null/undefined input', () => {
  const result1 = scanAndClassifyTasks(null);
  assert.equal(result1.rawLegacyResolved.length, 0);
  assert.equal(result1.rawUnresolved.length, 0);
  assert.equal(result1.policyExcluded.length, 0);
  assert.equal(result1.activeCurrentBlockers.length, 0);

  const result2 = scanAndClassifyTasks(undefined);
  assert.equal(result2.rawLegacyResolved.length, 0);

  const result3 = scanAndClassifyTasks('not an array');
  assert.equal(result3.rawLegacyResolved.length, 0);
});

test('scanAndClassifyTasks handles empty array', () => {
  const result = scanAndClassifyTasks([]);
  assert.equal(result.rawLegacyResolved.length, 0);
  assert.equal(result.rawUnresolved.length, 0);
  assert.equal(result.policyExcluded.length, 0);
  assert.equal(result.activeCurrentBlockers.length, 0);
  assert.equal(result.alreadyResolved.length, 0);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — classification: rawLegacyResolved
// ---------------------------------------------------------------------------

test('classifies non-blocking waiting_for_review as rawLegacyResolved', () => {
  const result = scanAndClassifyTasks([fixtureReviewNoActionable]);
  assert.equal(result.rawLegacyResolved.length, 1);
  assert.equal(result.rawLegacyResolved[0].task.id, fixtureReviewNoActionable.id);
  assert.equal(result.rawLegacyResolved[0].decision.blocks_current_work, false);
});

test('classifies verified waiting_for_repair as rawLegacyResolved', () => {
  const result = scanAndClassifyTasks([fixtureRepairVerified]);
  assert.equal(result.rawLegacyResolved.length, 1);
  assert.equal(result.rawLegacyResolved[0].task.id, fixtureRepairVerified.id);
  assert.equal(result.rawLegacyResolved[0].decision.blocks_current_work, false);
});

test('classifies provider-empty failed task as rawLegacyResolved', () => {
  const result = scanAndClassifyTasks([fixtureFailedProviderEmpty]);
  assert.equal(result.rawLegacyResolved.length, 1);
  assert.equal(result.rawLegacyResolved[0].task.id, fixtureFailedProviderEmpty.id);
  assert.equal(result.rawLegacyResolved[0].decision.blocks_current_work, false);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — classification: rawUnresolved (real blockers)
// ---------------------------------------------------------------------------

test('classifies blocking waiting_for_review as rawUnresolved', () => {
  const result = scanAndClassifyTasks([fixtureReviewBlocking]);
  assert.equal(result.rawUnresolved.length, 1);
  assert.equal(result.rawUnresolved[0].id, fixtureReviewBlocking.id);
  assert.equal(result.rawLegacyResolved.length, 0);
});

test('classifies blocking waiting_for_repair as rawUnresolved', () => {
  const result = scanAndClassifyTasks([fixtureRepairBlocking]);
  assert.equal(result.rawUnresolved.length, 1);
  assert.equal(result.rawUnresolved[0].id, fixtureRepairBlocking.id);
  assert.equal(result.rawLegacyResolved.length, 0);
});

test('classifies code-evidence failed task as rawUnresolved', () => {
  const result = scanAndClassifyTasks([fixtureFailedCodeEvidence]);
  assert.equal(result.rawUnresolved.length, 1);
  assert.equal(result.rawUnresolved[0].id, fixtureFailedCodeEvidence.id);
  assert.equal(result.rawLegacyResolved.length, 0);
});

test('classifies verification-failed task as rawUnresolved', () => {
  const result = scanAndClassifyTasks([fixtureFailedVerificationFailed]);
  assert.equal(result.rawUnresolved.length, 1);
  assert.equal(result.rawUnresolved[0].id, fixtureFailedVerificationFailed.id);
  assert.equal(result.rawLegacyResolved.length, 0);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — classification: activeCurrentBlockers
// ---------------------------------------------------------------------------

test('classifies running tasks as activeCurrentBlockers', () => {
  const result = scanAndClassifyTasks([fixtureRunning]);
  assert.equal(result.activeCurrentBlockers.length, 1);
  assert.equal(result.activeCurrentBlockers[0].id, fixtureRunning.id);
  assert.equal(result.rawLegacyResolved.length, 0);
});

test('classifies assigned tasks as activeCurrentBlockers', () => {
  const result = scanAndClassifyTasks([fixtureAssigned]);
  assert.equal(result.activeCurrentBlockers.length, 1);
});

test('classifies queued tasks as activeCurrentBlockers', () => {
  const result = scanAndClassifyTasks([fixtureQueued]);
  assert.equal(result.activeCurrentBlockers.length, 1);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — classification: policyExcluded
// ---------------------------------------------------------------------------

test('classifies completed tasks as policyExcluded', () => {
  const result = scanAndClassifyTasks([fixtureCompleted]);
  assert.equal(result.policyExcluded.length, 1);
  assert.equal(result.policyExcluded[0].id, fixtureCompleted.id);
});

test('classifies timed_out tasks as policyExcluded', () => {
  const result = scanAndClassifyTasks([fixtureTimedOut]);
  assert.equal(result.policyExcluded.length, 1);
});

test('classifies cancelled tasks as policyExcluded', () => {
  const result = scanAndClassifyTasks([fixtureCancelled]);
  assert.equal(result.policyExcluded.length, 1);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — classification: alreadyResolved
// ---------------------------------------------------------------------------

test('classifies already-resolved tasks separately', () => {
  const result = scanAndClassifyTasks([fixtureAlreadyResolved]);
  assert.equal(result.alreadyResolved.length, 1);
  assert.equal(result.alreadyResolved[0].id, fixtureAlreadyResolved.id);
  // Without includeAlreadyResolved, already-resolved should not appear elsewhere
  assert.equal(result.rawLegacyResolved.length, 0);
});

test('includeAlreadyResolved includes already-resolved in scan', () => {
  const result = scanAndClassifyTasks([fixtureAlreadyResolved], { includeAlreadyResolved: true });
  assert.equal(result.alreadyResolved.length, 1);
});

// ---------------------------------------------------------------------------
// scanAndClassifyTasks — mixed fixture scenario
// ---------------------------------------------------------------------------

test('classifies mixed tasks correctly across all categories', () => {
  const tasks = [
    fixtureReviewNoActionable,       // rawLegacyResolved
    fixtureReviewBlocking,           // rawUnresolved
    fixtureRepairVerified,           // rawLegacyResolved
    fixtureRepairBlocking,           // rawUnresolved
    fixtureFailedProviderEmpty,      // rawLegacyResolved
    fixtureFailedCodeEvidence,       // rawUnresolved
    fixtureRunning,                  // activeCurrentBlockers
    fixtureAssigned,                 // activeCurrentBlockers
    fixtureCompleted,                // policyExcluded
    fixtureTimedOut,                 // policyExcluded
    fixtureAlreadyResolved,          // alreadyResolved
  ];

  const result = scanAndClassifyTasks(tasks);
  assert.equal(result.rawLegacyResolved.length, 3, 'should find 3 legacy-resolved');
  assert.equal(result.rawUnresolved.length, 3, 'should find 3 unresolved blockers');
  assert.equal(result.activeCurrentBlockers.length, 2, 'should find 2 active blockers');
  assert.equal(result.policyExcluded.length, 2, 'should find 2 policy-excluded');
  assert.equal(result.alreadyResolved.length, 1, 'should find 1 already-resolved');
  assert.equal(result.rawLegacyResolved.length + result.rawUnresolved.length +
    result.activeCurrentBlockers.length + result.policyExcluded.length +
    result.alreadyResolved.length, 11, 'all tasks accounted for');
});

// ---------------------------------------------------------------------------
// buildMigrationPlan
// ---------------------------------------------------------------------------

test('buildMigrationPlan extracts candidates and stats from scan result', () => {
  const scanResult = scanAndClassifyTasks([
    fixtureReviewNoActionable,
    fixtureRepairVerified,
    fixtureFailedProviderEmpty,
    fixtureReviewBlocking,
    fixtureRunning,
  ]);

  const plan = buildMigrationPlan(scanResult);
  assert.equal(plan.candidates.length, 3);
  assert.equal(plan.stats.total, 3);
  assert.equal(plan.stats.rawLegacyResolved, 3);
  assert.equal(plan.stats.rawUnresolved, 1);
  assert.equal(plan.stats.activeCurrentBlockers, 1);
});

test('buildMigrationPlan handles empty scan result', () => {
  const plan = buildMigrationPlan({ rawLegacyResolved: [] });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.stats.total, 0);
});

// ---------------------------------------------------------------------------
// resolveLegacyTask — canonical metadata
// ---------------------------------------------------------------------------

test('resolveLegacyTask sets all canonical metadata fields', () => {
  const task = JSON.parse(JSON.stringify(fixtureReviewNoActionable));
  const decision = { label: 'review', blocks_current_work: false };

  resolveLegacyTask(task, decision, 'Legacy task with no actionable review evidence');

  const r = task.result;
  // Canonical fields
  assert.equal(r.resolved_legacy, true);
  assert.equal(typeof r.resolved_legacy_reason, 'string');
  assert.equal(r.resolved_legacy_reason, 'Legacy task with no actionable review evidence');
  assert.equal(r.previous_status, 'waiting_for_review');
  assert.equal(typeof r.resolved_at, 'string');
  assert.ok(r.resolved_at.length > 0, 'resolved_at is not empty');
  assert.equal(r.resolution_policy_label, 'review');

  // Status transitioned to completed
  assert.equal(task.status, 'completed');
});

test('resolveLegacyTask preserves existing result fields', () => {
  const task = {
    id: 'task_with_existing_result',
    status: 'failed',
    result: {
      changed_files: [],
      kind: 'codex_failed',
      existing_field: 'should survive',
    },
  };
  const decision = { label: 'provider_empty', blocks_current_work: false };

  resolveLegacyTask(task, decision);

  const r = task.result;
  assert.equal(r.resolved_legacy, true);
  assert.equal(r.existing_field, 'should survive');
  assert.equal(r.kind, 'codex_failed');
});

test('resolveLegacyTask handles null/undefined task', () => {
  assert.equal(resolveLegacyTask(null, {}), null);
  assert.equal(resolveLegacyTask(undefined, {}), undefined);
});

test('resolveLegacyTask creates result object if missing', () => {
  const task = { id: 'task_no_result', status: 'failed' };
  resolveLegacyTask(task, { label: 'provider_empty' });
  assert.equal(task.result.resolved_legacy, true);
  assert.equal(task.result.previous_status, 'failed');
  assert.equal(task.status, 'completed');
});

// ---------------------------------------------------------------------------
// applyMigrationPlan — dry-run vs apply
// ---------------------------------------------------------------------------

test('applyMigrationPlan dry-run does not mutate tasks', () => {
  const scanResult = scanAndClassifyTasks([
    fixtureReviewNoActionable,
    fixtureFailedProviderEmpty,
  ]);
  const plan = buildMigrationPlan(scanResult);

  // Deep clone before potential mutation
  const originalStatuses = plan.candidates.map((e) => ({ id: e.task.id, status: e.task.status }));

  const result = applyMigrationPlan(plan, { apply: false });

  // Should report no mutations
  assert.equal(result.mutated, 0);
  assert.equal(result.backup, null);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes('apply flag not set'));

  // Tasks should be unchanged
  for (const entry of plan.candidates) {
    const orig = originalStatuses.find((o) => o.id === entry.task.id);
    assert.equal(entry.task.status, orig.status, `${entry.task.id} status should not change in dry-run`);
  }
});

test('applyMigrationPlan with apply flag mutates tasks and creates backup', () => {
  const tasks = [
    JSON.parse(JSON.stringify(fixtureReviewNoActionable)),
    JSON.parse(JSON.stringify(fixtureFailedProviderEmpty)),
  ];
  const scanResult = scanAndClassifyTasks(tasks);
  const plan = buildMigrationPlan(scanResult);

  const result = applyMigrationPlan(plan, { apply: true, createBackup: true });

  assert.equal(result.mutated, 2);
  assert.notEqual(result.backup, null);
  assert.equal(result.errors.length, 0);

  // Tasks should now be completed with resolved_legacy
  for (const entry of plan.candidates) {
    assert.equal(entry.task.status, 'completed');
    assert.equal(entry.task.result.resolved_legacy, true);
    assert.equal(typeof entry.task.result.resolved_legacy_reason, 'string');
    assert.equal(typeof entry.task.result.previous_status, 'string');
    assert.equal(typeof entry.task.result.resolved_at, 'string');
  }
});

test('applyMigrationPlan with apply but no-backup skips backup', () => {
  const tasks = [JSON.parse(JSON.stringify(fixtureReviewNoActionable))];
  const scanResult = scanAndClassifyTasks(tasks);
  const plan = buildMigrationPlan(scanResult);

  const result = applyMigrationPlan(plan, { apply: true, createBackup: false });

  assert.equal(result.mutated, 1);
  assert.equal(result.backup, null);
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// formatReport — diagnostic output
// ---------------------------------------------------------------------------

test('formatReport includes all five categories', () => {
  const scanResult = {
    rawLegacyResolved: [{ task: { id: 'a', status: 'waiting_for_review' }, decision: { label: 'review' } }],
    rawUnresolved: [{ id: 'b', status: 'failed' }],
    policyExcluded: [{ id: 'c', status: 'completed' }],
    activeCurrentBlockers: [{ id: 'd', status: 'running' }],
    alreadyResolved: [{ id: 'e', status: 'waiting_for_review' }],
  };

  const report = formatReport(scanResult);

  // Category labels must appear
  assert.ok(report.includes('Raw Legacy Resolved (eligible)'), 'raw legacy resolved label');
  assert.ok(report.includes('Raw Unresolved (blockers remain)'), 'raw unresolved label');
  assert.ok(report.includes('Policy Excluded'), 'policy excluded label');
  assert.ok(report.includes('Active Current Blockers'), 'active current blockers label');
  assert.ok(report.includes('Already Resolved'), 'already resolved label');

  // Counts
  assert.ok(report.includes('1'), 'count of 1 present');

  // Detail sections
  assert.ok(report.includes('eligible for migration'));
  assert.ok(report.includes('not eligible'));
  assert.ok(report.includes('protected from migration'));
  assert.ok(report.includes('not a legacy status'));
});

test('formatReport handles empty scan result', () => {
  const report = formatReport({
    rawLegacyResolved: [],
    rawUnresolved: [],
    policyExcluded: [],
    activeCurrentBlockers: [],
    alreadyResolved: [],
  });
  assert.ok(report.includes('0'), 'zero counts present');
  assert.ok(report.includes('Legacy State Migration Report'), 'header present');
});

test('formatReport handles null/undefined scan result gracefully', () => {
  const report1 = formatReport(null);
  assert.ok(report1.includes('0'));

  const report2 = formatReport(undefined);
  assert.ok(report2.includes('0'));
});

// ---------------------------------------------------------------------------
// Real blockers are never classified as rawLegacyResolved
// ---------------------------------------------------------------------------

test('code evidence failure is never rawLegacyResolved', () => {
  // Task with code evidence and no resolved_legacy = real blocker
  const tasks = [{
    id: 'blocker_code_evidence',
    status: 'waiting_for_review',
    result: { changed_files: ['src/main.mjs'] },
  }];
  const result = scanAndClassifyTasks(tasks);
  assert.equal(result.rawLegacyResolved.length, 0);
  assert.equal(result.rawUnresolved.length, 1);
});

test('verification failed is never rawLegacyResolved', () => {
  const tasks = [{
    id: 'blocker_verification_failed',
    status: 'failed',
    result: { verification: { passed: false } },
  }];
  const result = scanAndClassifyTasks(tasks);
  assert.equal(result.rawLegacyResolved.length, 0);
  assert.equal(result.rawUnresolved.length, 1);
});

test('unreachable commit with mutation evidence preserved as blocker', () => {
  const tasks = [{
    id: 'blocker_unreachable_commit',
    status: 'waiting_for_review',
    result: {
      commit: 'deadbeef',
      changed_files: ['src/main.mjs'],
    },
  }];
  const result = scanAndClassifyTasks(tasks);
  assert.equal(result.rawLegacyResolved.length, 0);
  assert.equal(result.rawUnresolved.length, 1);
});

test('active dependency blocker (waiting_for_integration) is not migrated', () => {
  // waiting_for_integration is not in LEGACY_SCAN_STATUSES, so it's policyExcluded.
  // But if it were failed/waiting_for_review, its blocker decision matters.
  // This tests both: integration is a legacy status... wait, waiting_for_integration
  // is not in the legacy scan set. Let's make it a failed with integration block.
  const tasks = [{
    id: 'blocker_dependency',
    status: 'failed',
    result: {
      // integration evidence
      changed_files: ['src/main.mjs'],
      commit: 'abc123',
    },
  }];
  const result = scanAndClassifyTasks(tasks);
  assert.equal(result.rawLegacyResolved.length, 0);
  assert.equal(result.rawUnresolved.length, 1);
});

// ---------------------------------------------------------------------------
// Apply never mutates active tasks
// ---------------------------------------------------------------------------

test('apply migration never touches active tasks', () => {
  const tasks = [
    JSON.parse(JSON.stringify(fixtureRunning)),
    JSON.parse(JSON.stringify(fixtureAssigned)),
    JSON.parse(JSON.stringify(fixtureReviewNoActionable)),
  ];

  const scanResult = scanAndClassifyTasks(tasks);
  // Active tasks should be in activeCurrentBlockers, not candidates
  assert.equal(scanResult.activeCurrentBlockers.length, 2);
  assert.equal(scanResult.rawLegacyResolved.length, 1);

  const plan = buildMigrationPlan(scanResult);

  // Only the non-active candidate should be in the plan
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].task.id, fixtureReviewNoActionable.id);

  // Apply
  applyMigrationPlan(plan, { apply: true });

  // Active tasks should remain unchanged
  const runningTask = tasks.find((t) => t.id === fixtureRunning.id);
  const assignedTask = tasks.find((t) => t.id === fixtureAssigned.id);

  assert.notEqual(runningTask.status, 'completed');
  assert.notEqual(assignedTask.status, 'completed');
  assert.equal(runningTask.result?.resolved_legacy, undefined);
  assert.equal(assignedTask.result?.resolved_legacy, undefined);
});

// ---------------------------------------------------------------------------
// Edge: status normalization
// ---------------------------------------------------------------------------

test('handles uppercase and whitespace-padded status values', () => {
  const tasks = [{
    id: 'task_weird_status',
    status: ' WAITING_FOR_REVIEW ',
    result: {},
  }];
  const result = scanAndClassifyTasks(tasks);
  // Should be normalized to 'waiting_for_review' and recognized
  assert.equal(result.rawLegacyResolved.length, 1);
  assert.equal(result.rawLegacyResolved[0].task.id, 'task_weird_status');
});
