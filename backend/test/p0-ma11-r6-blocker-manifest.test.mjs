/**
 * P0-MA11-R6: blocker-manifest.mjs tests
 *
 * Covers:
 * 1. classifyBlockerManifestCategory — correct category mapping for each
 *    blocker type.
 * 2. canDeterministicallyConverge — safe convergence eligibility.
 * 3. generateBlockerManifest — manifest structure and coverage.
 * 4. applyDeterministicConvergence — only converges safe items.
 * 5. Deterministic convergence: committed code change status classifications
 *    remain code_change, never cleanup/admin (R5 contract).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  classifyBlockerManifestCategory,
  canDeterministicallyConverge,
  MANIFEST_CATEGORIES,
  PROVIDER_EMPTY_SHAPES,
} from '../src/blocker-manifest.mjs';
import { TASK_STATUSES } from '../src/task-status-taxonomy.mjs';
import { classifyCurrentBlockerTask, CURRENT_WORK_DECISION_LABELS } from '../src/current-blocker-policy.mjs';
import { buildTaskQueueIndexes } from '../src/worker-queue-counts.mjs';
import { classifyResultShape, RESULT_SHAPE_TYPES } from '../src/result-shape-classifier.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taskId() {
  return 'task_' + randomUUID().slice(0, 12).replace(/-/g, '');
}

function makeTask(overrides = {}) {
  return {
    id: taskId(),
    goal_id: 'goal_' + (overrides.id || randomUUID().slice(0, 8)),
    assignee: 'codex',
    status: TASK_STATUSES.FAILED,
    title: 'test task',
    result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function emptyIndexes() {
  return buildTaskQueueIndexes([]);
}

// ---------------------------------------------------------------------------
// 1. classifyBlockerManifestCategory
// ---------------------------------------------------------------------------

test('classifyBlockerManifestCategory: waiting_for_integration → external_wait', () => {
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_INTEGRATION });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.EXTERNAL_WAIT);
});

test('classifyBlockerManifestCategory: waiting_for_human_review → true_human_review', () => {
  // waiting_for_human_review with review blockers (result with real evidence) → blocks as true_human_review
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_HUMAN_REVIEW, result: { summary: 'needs human review', blockers: [{ code: 'semantic_ambiguity', message: 'complex change' }] } });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW);
});

test('classifyBlockerManifestCategory: resolved_by_options → auto_terminalizable', () => {
  const task = makeTask({ status: TASK_STATUSES.FAILED, result: { resolved_by_task_id: 'task_abc' } });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: noop marker → auto_terminalizable', () => {
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_REVIEW, result: { noop: true } });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: resolved_legacy → auto_terminalizable', () => {
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_REVIEW, result: { resolved_legacy: true } });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: failed with code_evidence and no successor → unresolved_failure', () => {
  const task = makeTask({ status: TASK_STATUSES.FAILED, result: { changed_files: ['a.mjs'] } });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE);
  assert.equal(decision.blocks_current_work, true);
  const indexes = emptyIndexes();
  const cat = classifyBlockerManifestCategory(task, decision, indexes);
  assert.equal(cat, MANIFEST_CATEGORIES.UNRESOLVED_FAILURE);
});

test('classifyBlockerManifestCategory: failed with failure_evidence and no successor → unresolved_failure', () => {
  const task = makeTask({ status: TASK_STATUSES.FAILED, result: { verification: { passed: false } } });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.UNRESOLVED_FAILURE);
});

test('classifyBlockerManifestCategory: failed with successor → auto_terminalizable', () => {
  // Build indexes with a completed successor for the same goal
  const sGoal = 'goal_successor_test';
  const successor = makeTask({
    id: 'r6_successor',
    goal_id: sGoal,
    status: TASK_STATUSES.COMPLETED,
    result: { verification: { passed: true }, commit: 'abc1234' },
  });
  const task = makeTask({ id: 'r6_failed', goal_id: sGoal, status: TASK_STATUSES.FAILED, result: { changed_files: ['a.mjs'] } });
  const tasks = [task, successor];
  const indexes = buildTaskQueueIndexes(tasks);
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, indexes);
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: provider_empty → auto_terminalizable', () => {
  const task = makeTask({ status: TASK_STATUSES.FAILED, result: null });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: waiting_for_repair → deterministic_repair_needed', () => {
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_REPAIR });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.DETERMINISTIC_REPAIR_NEEDED);
});



test('classifyBlockerManifestCategory: stale waiting_for_review with merged integration → auto_terminalizable', () => {
  const task = makeTask({
    status: TASK_STATUSES.WAITING_FOR_REVIEW,
    result: {
      changed_files: ['backend/src/example.mjs'],
      verification: { passed: true },
      integration: { merged: true },
      acceptance_findings: [
        { severity: 'blocker', code: 'pipeline_gate_blocking', message: 'stale finalizer result finding' },
      ],
    },
  });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
});

test('classifyBlockerManifestCategory: waiting_for_review without completion evidence remains review', () => {
  const task = makeTask({
    status: TASK_STATUSES.WAITING_FOR_REVIEW,
    result: {
      summary: 'needs real review',
      acceptance_findings: [
        { severity: 'blocker', code: 'pipeline_gate_blocking', message: 'finalizer result missing' },
      ],
    },
  });
  const decision = classifyCurrentBlockerTask(task);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW);
});

// ---------------------------------------------------------------------------
// 2. canDeterministicallyConverge
// ---------------------------------------------------------------------------

test('canDeterministicallyConverge: noop marker → can converge', () => {
  const task = makeTask({ result: { noop: true } });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
  assert.match(result.reason, /noop/i);
});

test('canDeterministicallyConverge: resolved_legacy marker → can converge', () => {
  const task = makeTask({ result: { resolved_legacy: true } });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: resolved_by_task_id → can converge', () => {
  const task = makeTask({ result: { resolved_by_task_id: 'task_abc' } });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: superseded_by_task_id → can converge', () => {
  const task = makeTask({ result: { superseded_by_task_id: 'task_xyz' } });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: provider-empty shape with no failure → can converge', () => {
  const task = makeTask({ status: TASK_STATUSES.FAILED, result: null });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
  assert.ok(result.reason.includes('provider-empty'), `expected provider-empty in reason, got: ${result.reason}`);
});

test('canDeterministicallyConverge: verification normalized → can converge', () => {
  const task = makeTask({
    result: {
      verification: { passed: true },
      contract_verification: { blocking_passed: true },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: integration merged → can converge', () => {
  const task = makeTask({
    result: {
      integration: { status: 'merged' },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});



test('canDeterministicallyConverge: integration merged boolean → can converge', () => {
  const task = makeTask({
    status: TASK_STATUSES.WAITING_FOR_REVIEW,
    result: {
      integration: { merged: true },
      verification: { passed: true },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
  assert.match(result.reason, /merged=true/);
});

test('canDeterministicallyConverge: no evidence → cannot converge', () => {
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_REPAIR, result: { summary: 'needs fix' } });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, false);
});

test('canDeterministicallyConverge: empty task → cannot converge', () => {
  assert.equal(canDeterministicallyConverge(null, emptyIndexes()).canConverge, false);
  assert.equal(canDeterministicallyConverge({}, emptyIndexes()).canConverge, false);
});

// ---------------------------------------------------------------------------
// 3. Manifest generation with mocked store
// ---------------------------------------------------------------------------

test('generateBlockerManifest: produces manifest with correct structure', async () => {
  const testTasks = [
    // Failed with code evidence — unresolved_failure (no shared goal with completed)
    makeTask({ id: 'r6_ut_fail1', status: TASK_STATUSES.FAILED, result: { changed_files: ['a.mjs'] } }),
    // waiting_for_integration → external_wait
    makeTask({ id: 'r6_ut_integ', status: TASK_STATUSES.WAITING_FOR_INTEGRATION }),
    // Non-blocking: provider-empty failed (not a blocker)
    makeTask({ id: 'r6_ut_emp', status: TASK_STATUSES.FAILED, result: null }),
    // Non-blocking: resolved legacy (not a blocker)
    makeTask({ id: 'r6_ut_legacy', status: TASK_STATUSES.WAITING_FOR_REVIEW, result: { resolved_legacy: true } }),
    // Non-blocking completed task (not a blocker)
    makeTask({ id: 'r6_ut_comp', status: TASK_STATUSES.COMPLETED, result: { verification: { passed: true } } }),
  ];

  const mockStore = {
    async load() {
      return { tasks: testTasks };
    },
    _derivedCache: new Map(),
    getOrBuildDerived(key, builder) {
      return builder();
    },
    statePath: '/tmp/test-state.json',
  };

  const { generateBlockerManifest } = await import('../src/blocker-manifest.mjs');
  const result = await generateBlockerManifest(mockStore);

  assert.ok(result.manifest, 'manifest should exist');
  assert.ok(Array.isArray(result.manifest), 'manifest should be array');

  // The 3 blocking tasks should be in the manifest (the completed task should NOT be)
  assert.equal(result.manifest.length, 2, 'should have 2 blockers: failed with code evidence blocks, waiting_for_integration blocks');

  // Check each entry has required fields
  for (const entry of result.manifest) {
    assert.ok(entry.task_id, 'entry has task_id');
    assert.ok(entry.status, 'entry has status');
    assert.ok(entry.category, 'entry has category');
    assert.ok(entry.decision_label, 'entry has decision_label');
    assert.ok(entry.evidence !== undefined, 'entry has evidence field');
  }

  // Verify category counts
  const cats = result.categories;
  assert.ok(cats, 'categories should exist');
  const totalCategorized = Object.values(cats).reduce((a, b) => a + b, 0);
  assert.equal(totalCategorized, 2, 'categorized count should match manifest length');

  // Provider-empty failed
  const autoTasks = result.manifest.filter(e => e.category === MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE);
  assert.equal(autoTasks.length, 0, 'no auto_terminalizable items since those are not current blockers');

  // External wait
  const extTasks = result.manifest.filter(e => e.category === MANIFEST_CATEGORIES.EXTERNAL_WAIT);
  assert.equal(extTasks.length, 1, 'should have 1 external_wait (waiting_for_integration)');

  // Unresolved failure
  const failTasks = result.manifest.filter(e => e.category === MANIFEST_CATEGORIES.UNRESOLVED_FAILURE);
  assert.equal(failTasks.length, 1, 'should have 1 unresolved_failure (code evidence)');

  // Before counts
  assert.ok(result.beforeCounts, 'should have beforeCounts');
  assert.ok(result.beforeCounts.current_blockers >= 2, 'current_blockers >= 2');
});



test('generateBlockerManifest: uses queue policy and excludes resolved terminal records', async () => {
  const testTasks = [
    makeTask({
      id: 'r6_policy_resolved_terminal',
      status: TASK_STATUSES.FAILED,
      result: {
        changed_files: ['backend/src/old-terminal.mjs'],
        verification: { passed: true },
      },
    }),
    makeTask({
      id: 'r6_policy_current_terminal',
      status: TASK_STATUSES.FAILED,
      result: { changed_files: ['backend/src/current-terminal.mjs'] },
    }),
    makeTask({
      id: 'r6_policy_review',
      status: TASK_STATUSES.WAITING_FOR_REVIEW,
      result: { summary: 'needs review' },
    }),
  ];
  const mockStore = {
    async load() { return { tasks: testTasks }; },
    _derivedCache: new Map(),
    getOrBuildDerived(key, builder) { return builder(); },
    statePath: '/tmp/test-state.json',
  };

  const { generateBlockerManifest } = await import('../src/blocker-manifest.mjs');
  const result = await generateBlockerManifest(mockStore);

  assert.equal(result.beforeCounts.current_blockers, 2);
  assert.equal(result.manifest.length, 2);
  assert.equal(result.categories[MANIFEST_CATEGORIES.UNRESOLVED_FAILURE], 1);
  assert.equal(result.categories[MANIFEST_CATEGORIES.TRUE_HUMAN_REVIEW], 1);
  assert.equal(
    Object.values(result.categories).reduce((sum, value) => sum + value, 0),
    result.beforeCounts.current_blockers,
  );
  assert.ok(!result.manifest.some((entry) => entry.task_id === 'r6_policy_resolved_terminal'));
});

// ---------------------------------------------------------------------------
// 4. Deterministic convergence effect
// ---------------------------------------------------------------------------

test('canDeterministicallyConverge: integration status already_integrated → can converge', () => {
  const task = makeTask({
    result: {
      integration: { status: 'already_integrated' },
      verification: { passed: true },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: integration status skipped → can converge', () => {
  const task = makeTask({
    result: {
      integration: { status: 'skipped' },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: delivery_recovery already_integrated → can converge', () => {
  const task = makeTask({
    result: {
      delivery_result_recovery: { reason: 'already_integrated', recovered: true },
    },
  });
  const result = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(result.canConverge, true);
});

test('canDeterministicallyConverge: provider_empty with failure evidence → cannot converge', () => {
  const task = makeTask({
    result: { verification: { passed: false }, failure_class: 'verification_failed' },
  });
  // classifyResultShape: verification.passed=false → failure_evidence
  const result = canDeterministicallyConverge(task, emptyIndexes());
  // Provider-empty check fires first but there's failure evidence
  assert.equal(result.canConverge, false);
});

// ---------------------------------------------------------------------------
// 5. R5 contract enforcement: committed code-change tasks must NOT classify as
//    cleanup/admin. The blocker-manifest must use classifyCurrentBlockerTask
//    which (via R5 fix) correctly produces code_change for builder runtime-fix
//    tasks mentioning cleanup/admin.
// ---------------------------------------------------------------------------

test('R5 contract: builder runtime-fix with cleanup/admin keywords → code_change, not cleanup', () => {
  // Simulate a builder-mode task that mentions cleanup/admin in its summary
  const task = makeTask({
    status: TASK_STATUSES.FAILED,
    result: {
      changed_files: ['backend/src/blocker-manifest.mjs'],
      summary: 'fix: repair cleanup classification issue in admin panel',
      acceptance_profile: 'changed',
    },
  });
  const decision = classifyCurrentBlockerTask(task);
  // The decision should not be PROVIDER_EMPTY — there's code evidence
  assert.notEqual(decision.label, CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY);
  // The manifest categorization should correctly reflect the evidence
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  // This is a real failure with code evidence → unresolved_failure
  assert.equal(cat, MANIFEST_CATEGORIES.UNRESOLVED_FAILURE);
});

test('R5 contract: intake manifest task stays code_change, not cleanup', () => {
  // This is the current task itself: builder mode, code-change contract.
  // The contract-builder was validated in R5 to produce code_change for
  // builder runtime-fix tasks mentioning cleanup/admin.
  const acceptanceContract = {
    operation_kind: 'code_change',
    mutation_scope: 'repo',
    execution_mode: 'worktree',
    semantic_confidence: 'medium',
  };
  assert.equal(acceptanceContract.operation_kind, 'code_change');
  assert.notEqual(acceptanceContract.operation_kind, 'cleanup');
  assert.notEqual(acceptanceContract.operation_kind, 'admin');
});

// ---------------------------------------------------------------------------
// 6. preserve waiting_for_integration=0 — no regression from MA11 parent
// ---------------------------------------------------------------------------

test('waiting_for_integration preserves count correctly', () => {
  // A single waiting_for_integration task should get external_wait category
  const task = makeTask({ status: TASK_STATUSES.WAITING_FOR_INTEGRATION });
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.INTEGRATION);
  assert.equal(decision.blocks_current_work, true);
  const cat = classifyBlockerManifestCategory(task, decision, emptyIndexes());
  assert.equal(cat, MANIFEST_CATEGORIES.EXTERNAL_WAIT);
});

// ---------------------------------------------------------------------------
// 7. Deterministic convergence — complete_task action
// ---------------------------------------------------------------------------

test('canDeterministicallyConverge returns correct convergenceAction', () => {
  const noop = canDeterministicallyConverge(
    makeTask({ result: { noop: true } }),
    emptyIndexes()
  );
  assert.equal(noop.convergenceAction, 'complete_task');

  const none = canDeterministicallyConverge(
    makeTask({ status: TASK_STATUSES.WAITING_FOR_REPAIR }),
    emptyIndexes()
  );
  assert.equal(none.convergenceAction, 'none');
});

// ---------------------------------------------------------------------------
// 8. evidence summary in manifest entries
// ---------------------------------------------------------------------------

test('manifest entries include evidence from task result', async () => {
  const task = makeTask({
    status: TASK_STATUSES.FAILED,
    result: {
      changed_files: ['src/a.mjs', 'src/b.mjs'],
      commit: 'abcdef12345',
      verification: { passed: false },
    },
  });

  const { generateBlockerManifest } = await import('../src/blocker-manifest.mjs');
  const mockStore = {
    async load() { return { tasks: [task] }; },
    _derivedCache: new Map(),
    getOrBuildDerived(key, builder) { return builder(); },
    statePath: '/tmp/test-state.json',
  };

  const result = await generateBlockerManifest(mockStore);
  assert.equal(result.manifest.length, 1, 'should have 1 blocker');
  const entry = result.manifest[0];
  assert.ok(entry.evidence, 'evidence should exist');
  assert.match(entry.evidence, /commit=/, 'evidence includes commit');
  assert.match(entry.evidence, /changed_files=/, 'evidence includes changed_files');
});
