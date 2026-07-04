/**
 * ma12-g4-terminal-anomaly-convergence.test.mjs
 *
 * P0-MA12-G4: Safe convergence of 13 terminal anomaly blockers.
 *
 * Tests the complete terminal-anomaly convergence pipeline:
 *   1. 13 terminal anomaly scenarios across all blocker policy categories
 *   2. 4 specific regression convergence paths:
 *      a) already-integrated terminal anomaly -> resolved terminal
 *      b) successor-resolved terminal anomaly -> resolved_by_successor
 *      c) no-result-with-commit recovery -> recover and close
 *      d) true issue staying blocking -> remains blocked with exact reason
 *   3. Manifest generation classifies all 13 correctly
 *   4. Deterministic convergence applied correctly
 *   5. Terminal anomaly count decreases safely (no fake zero)
 */

import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyBlockerManifestCategory,
  canDeterministicallyConverge,
  generateBlockerManifest,
  applyDeterministicConvergence,
  MANIFEST_CATEGORIES,
} from '../src/blocker-manifest.mjs';
import {
  CURRENT_WORK_DECISION_LABELS,
  classifyCurrentBlockerTask,
} from '../src/current-blocker-policy.mjs';
import {
  buildTaskQueueIndexes,
  computePolicyQueueCounts,
  isPolicyCurrentBlockerTask,
} from '../src/worker-queue-counts.mjs';
import { TASK_STATUSES } from '../src/task-status-taxonomy.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANONICAL_REPO = process.cwd();

function taskId() {
  return 'task_' + randomUUID().slice(0, 12).replace(/-/g, '');
}

function makeTask(overrides = {}) {
  return {
    id: taskId(),
    goal_id: 'goal_' + (overrides.id || randomUUID().slice(0, 8)),
    assignee: 'codex',
    status: TASK_STATUSES.FAILED,
    title: 'test terminal anomaly task',
    result: null,
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    updated_at: new Date(Date.now() - 1800_000).toISOString(),
    ...overrides,
  };
}

function emptyIndexes() {
  return buildTaskQueueIndexes([]);
}

function makeMockStore(tasks) {
  return {
    async load() {
      return { tasks: [...tasks] };
    },
    _derivedCache: new Map(),
    getOrBuildDerived(key, builder) {
      return builder();
    },
    statePath: '/tmp/test-ma12-g4-state.json',
    state: { tasks: [...tasks] },
    async mutate(fn) {
      const newState = fn({ tasks: [...this.state.tasks] });
      this.state = newState;
      this.state.tasks = this.state.tasks || [];
      return newState;
    },
  };
}

/**
 * Create a temporary git repo and initial commit for reachable-commit tests.
 * Returns { root, commit }.
 */
function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-ma12-g4-'));
  mkdirSync(join(root, 'repo'));
  execFileSync('git', ['init'], { cwd: join(root, 'repo'), stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(root, 'repo') });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(root, 'repo') });
  writeFileSync(join(root, 'repo', 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: join(root, 'repo') });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: join(root, 'repo'), stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, 'repo'), encoding: 'utf8' }).trim();
  return { root, commit };
}

// ===========================================================================
// 1. 13 Terminal Anomaly Scenarios -- Manifest Classification
// ===========================================================================

test('G4 manifest: all 13 terminal anomaly scenarios classify correctly', () => {
  const repo = makeGitRepo();
  const HEAD_COMMIT = repo.commit.slice(0, 12);

  // Build 13 terminal anomaly tasks
  const testGoal = 'goal_ma12_g4_test';

  // Helper to build scenario
  function scenario(opts) {
    return { extraTasks: [], ...opts };
  }

  const scenarios = [
    // 1. Already-integrated code evidence:
    //    failed + code evidence + reachable commit + verification -> auto_terminalizable
    scenario({
      id: 'g4_01', title: 'already-integrated code evidence',
      task: makeTask({ id: 'g4_01', goal_id: testGoal, status: TASK_STATUSES.FAILED,
        result: { changed_files: ['backend/src/example.mjs'], commit: HEAD_COMMIT, tests: 'all passed', execution_cwd: join(repo.root, 'repo') },
      }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /reachable from HEAD/,
    }),

    // 2. Already-integrated with tests evidence (no code files):
    //    failed + tests + reachable commit -> auto_terminalizable
    scenario({
      id: 'g4_02', title: 'already-integrated tests evidence',
      task: makeTask({ id: 'g4_02', goal_id: testGoal, status: TASK_STATUSES.FAILED,
        result: { changed_files: ['config.yml'], commit: HEAD_COMMIT, tests: 'config validated', execution_cwd: join(repo.root, 'repo') },
      }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /reachable from HEAD/,
    }),

    // 3. Successor-resolved code evidence:
    //    failed + code evidence + same-goal completed successor -> auto_terminalizable
    scenario({
      id: 'g4_03', title: 'successor-resolved code evidence',
      task: makeTask({ id: 'g4_03', goal_id: testGoal, result: { changed_files: ['backend/src/other.mjs'] } }),
      extraTasks: [makeTask({ id: 'g4_s3', goal_id: testGoal, status: TASK_STATUSES.COMPLETED,
        result: { verification: { passed: true }, commit: HEAD_COMMIT },
      })],
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /successor/,
    }),

    // 4. Successor-resolved failure evidence:
    //    failed + failure evidence + same-goal completed successor -> auto_terminalizable
    scenario({
      id: 'g4_04', title: 'successor-resolved failure evidence',
      task: makeTask({ id: 'g4_04', goal_id: testGoal, result: { verification: { passed: false } } }),
      extraTasks: [makeTask({ id: 'g4_s4', goal_id: testGoal, status: TASK_STATUSES.COMPLETED,
        result: { verification: { passed: true }, commit: HEAD_COMMIT },
      })],
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /successor/,
    }),

    // 5. Noop marker -> auto_terminalizable
    scenario({
      id: 'g4_05', title: 'noop marker',
      task: makeTask({ id: 'g4_05', goal_id: testGoal, result: { noop: true } }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /noop/,
    }),

    // 6. Resolved legacy -> auto_terminalizable
    scenario({
      id: 'g4_06', title: 'resolved legacy',
      task: makeTask({ id: 'g4_06', goal_id: testGoal, result: { resolved_legacy: true } }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /resolved_legacy/,
    }),

    // 7. Resolved by task ID -> auto_terminalizable
    scenario({
      id: 'g4_07', title: 'resolved by task',
      task: makeTask({ id: 'g4_07', goal_id: testGoal, result: { resolved_by_task_id: 'task_resolver' } }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /resolved_by_task_id/,
    }),

    // 8. Superseded by task ID -> auto_terminalizable
    scenario({
      id: 'g4_08', title: 'superseded by task',
      task: makeTask({ id: 'g4_08', goal_id: testGoal, result: { superseded_by_task_id: 'task_newer' } }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /superseded_by/,
    }),

    // 9. Provider empty null result -> auto_terminalizable
    scenario({
      id: 'g4_09', title: 'provider empty null',
      task: makeTask({ id: 'g4_09', goal_id: testGoal, result: null }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /provider-empty/,
    }),

    // 10. Provider timed out -> auto_terminalizable
    scenario({
      id: 'g4_10', title: 'provider timed out',
      task: makeTask({ id: 'g4_10', goal_id: testGoal, status: TASK_STATUSES.TIMED_OUT,
        result: { kind: 'codex_timeout', summary: 'timed out' },
      }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /provider-empty/,
    }),

    // 11. Delivery recovery already integrated -> auto_terminalizable
    scenario({
      id: 'g4_11', title: 'delivery recovery integrated',
      task: makeTask({ id: 'g4_11', goal_id: testGoal,
        result: { delivery_result_recovery: { reason: 'already_integrated', recovered: true, commit: HEAD_COMMIT },
                 verification: { passed: true } },
      }),
      expectedCat: MANIFEST_CATEGORIES.AUTO_TERMINALIZABLE,
      convergable: true, reasonPattern: /already_integrated/,
    }),

    // 12. True unrecoverable code evidence:
    //     failed + code evidence + no successor + no reachable commit -> unresolved_failure
    scenario({
      id: 'g4_12', title: 'true unrecoverable code evidence',
      task: makeTask({ id: 'g4_12', goal_id: 'goal_unrecov_' + randomUUID().slice(0, 8),
        result: { changed_files: ['backend/src/real-failure.mjs'], summary: 'Real product verification failure' },
      }),
      expectedCat: MANIFEST_CATEGORIES.UNRESOLVED_FAILURE,
      convergable: false, reasonPattern: /no safe convergence/,
    }),

    // 13. True unrecoverable failure evidence:
    //     failed + failure evidence + no successor + no convergence -> unresolved_failure
    scenario({
      id: 'g4_13', title: 'true unrecoverable failure evidence',
      task: makeTask({ id: 'g4_13', goal_id: 'goal_unrecov_' + randomUUID().slice(0, 8),
        result: { verification: { passed: false }, acceptance_findings: [{ severity: 'blocker', code: 'verification_failed', message: 'Tests failed' }] },
      }),
      expectedCat: MANIFEST_CATEGORIES.UNRESOLVED_FAILURE,
      convergable: false, reasonPattern: /no safe convergence/,
    }),
  ];

  // === Run classification for each scenario ===
  let unresolvedCount = 0;
  let convergableCount = 0;

  for (const sc of scenarios) {
    const tasks = [sc.task, ...(sc.extraTasks || [])];
    const indexes = buildTaskQueueIndexes(tasks);
    const decision = classifyCurrentBlockerTask(sc.task);
    const category = classifyBlockerManifestCategory(sc.task, decision, indexes);
    const converge = canDeterministicallyConverge(sc.task, indexes);

    // Verify classification matches expected
    assert.equal(category, sc.expectedCat,
      `Scenario ${sc.id} (${sc.title}): expected category=${sc.expectedCat}, got ${category}`);

    // Verify convergence eligibility
    assert.equal(converge.canConverge, sc.convergable,
      `Scenario ${sc.id}: convergable mismatch. Reason: ${converge.reason}`);

    if (converge.canConverge) {
      assert.ok(sc.reasonPattern.test(converge.reason),
        `Scenario ${sc.id}: reason "${converge.reason}" should match ${sc.reasonPattern}`);
      convergableCount += 1;
    } else {
      assert.ok(sc.reasonPattern.test(converge.reason),
        `Scenario ${sc.id}: reason "${converge.reason}" should match ${sc.reasonPattern}`);
      unresolvedCount += 1;
    }
  }

  // Verify: 11 convergable + 2 unresolved = 13 total
  assert.equal(convergableCount, 11, `Expected 11 convergable, got ${convergableCount}`);
  assert.equal(unresolvedCount, 2, `Expected 2 unresolved, got ${unresolvedCount}`);
});

// ===========================================================================
// 2. Regression Path A: Already-Integrated Terminal Anomaly
// ===========================================================================

test('G4 path A: already-integrated terminal anomaly is resolved by convergence', () => {
  // A failed task with code evidence, commit reachable from HEAD, and tests
  // evidence should be auto-converged by canDeterministicallyConverge.
  const HEAD_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: CANONICAL_REPO, encoding: 'utf8',
  }).trim();

  const task = makeTask({
    id: 'g4_pathA',
    title: 'already-integrated terminal anomaly',
    result: {
      changed_files: ['backend/src/example.mjs'],
      commit: HEAD_COMMIT,
      tests: 'npm test: all passed',
      execution_cwd: CANONICAL_REPO,
    },
  });

  const converge = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(converge.canConverge, true,
    `Expected canConverge=true, got: ${converge.reason}`);
  assert.ok(converge.reason.includes('reachable from HEAD'),
    `Reason should indicate reachable commit: ${converge.reason}`);
  assert.equal(converge.convergenceAction, 'complete_task');
});

test('G4 path A: already-integrated terminal anomaly count decreases via manifest', async () => {
  const HEAD_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: CANONICAL_REPO, encoding: 'utf8',
  }).trim();

  // Create 2 convergable (code evidence + reachable commit + tests) + 1 unrecoverable
  const goal = 'goal_g4_pathA';
  const tasks = [
    makeTask({ id: 'g4_A1', goal_id: goal,
      result: { changed_files: ['a.mjs'], commit: HEAD_COMMIT, tests: 'ok', execution_cwd: CANONICAL_REPO },
    }),
    makeTask({ id: 'g4_A2', goal_id: goal,
      result: { changed_files: ['b.mjs'], commit: HEAD_COMMIT, tests: 'ok', execution_cwd: CANONICAL_REPO },
    }),
    makeTask({ id: 'g4_A3', goal_id: 'goal_g4_pathA_unrecov',
      result: { changed_files: ['c.mjs'] },
    }),
  ];

  const store = makeMockStore(tasks);
  const manifest = await generateBlockerManifest(store);

  // Before: 3 failed terminal blockers
  assert.equal(manifest.beforeCounts.current_blockers, 3,
    `Expected 3 before-blockers, got ${manifest.beforeCounts.current_blockers}`);

  // Apply convergence
  const after = await applyDeterministicConvergence(store);

  // After: 1 blocker remains (the unrecoverable one)
  assert.equal(after.afterCounts.current_blockers, 1,
    `Expected 1 after-blocker, got ${after.afterCounts.current_blockers}`);
  assert.equal(after.converged.length, 2,
    `Expected 2 converged, got ${after.converged.length}`);
});

// ===========================================================================
// 3. Regression Path B: Successor-Resolved Terminal Anomaly
// ===========================================================================

test('G4 path B: successor-resolved terminal anomaly is resolved by successor', () => {
  const goalId = 'goal_g4_pathB';
  const successor = makeTask({
    id: 'g4_B_successor', goal_id: goalId, status: TASK_STATUSES.COMPLETED,
    result: { verification: { passed: true }, commit: 'abc1234' },
  });
  const failed = makeTask({
    id: 'g4_B_failed', goal_id: goalId,
    result: { changed_files: ['backend/src/example.mjs'] },
  });

  const indexes = buildTaskQueueIndexes([failed, successor]);
  const converge = canDeterministicallyConverge(failed, indexes);

  assert.equal(converge.canConverge, true,
    `Expected canConverge=true, got: ${converge.reason}`);
  assert.ok(converge.reason.includes('successor'),
    `Reason should reference successor: ${converge.reason}`);
});

test('G4 path B: successor-resolved terminal not counted as blocker via policy', () => {
  const goalId = 'goal_g4_pathB2';
  const successor = makeTask({
    id: 'g4_B2_succ', goal_id: goalId, status: TASK_STATUSES.COMPLETED,
    result: { verification: { passed: true }, commit: 'def5678' },
  });
  const failed = makeTask({
    id: 'g4_B2_fail', goal_id: goalId,
    result: { changed_files: ['other.mjs'] },
  });

  const indexes = buildTaskQueueIndexes([failed, successor]);
  const counts = computePolicyQueueCounts([failed, successor], indexes);
  assert.equal(counts.failed, 0,
    'Successor-resolved failed task should not count as blocker');
  assert.equal(counts.completed, 1,
    'Completed successor should be counted');
});

// ===========================================================================
// 4. Regression Path C: No-Result-With-Commit Recovery
// ===========================================================================

test('G4 path C: no-result-with-commit recovery via delivery_recovery', () => {
  const repo = makeGitRepo();
  const commit = repo.commit.slice(0, 12);

  const task = makeTask({
    id: 'g4_pathC', title: 'no-result-with-commit recovery',
    result: {
      delivery_result_recovery: {
        reason: 'result_missing_but_verified_commit',
        commit, recovered: true,
        worktree_path: join(repo.root, 'repo'),
      },
      tests: 'npm test: all passed',
      verification: { passed: true },
    },
  });

  // classifyCurrentBlockerTask should mark as non-blocking
  // (isRecoveredResultMissingVerifiedCommit -> RESOLVED_BY_OPTIONS)
  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS,
    `Expected RESOLVED_BY_OPTIONS, got ${decision.label}`);
  assert.equal(decision.blocks_current_work, false,
    'Recovered result-missing task should NOT block current work');

  // Also verify manifest convergence
  const converge = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(converge.canConverge, true,
    `Expected canConverge=true, got: ${converge.reason}`);
});

// ===========================================================================
// 5. Regression Path D: True Issue Staying Blocking
// ===========================================================================

test('G4 path D: true unrecoverable code evidence stays blocking', () => {
  // A failed task with code evidence (changed_files only, no verification),
  // no implicit successor, no integration evidence, and no reachable commit.
  const task = makeTask({
    id: 'g4_pathD', title: 'true unrecoverable code evidence',
    result: { changed_files: ['backend/src/real-failure.mjs'] },
  });

  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true,
    'True unrecoverable code evidence MUST stay blocking');
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE,
    `Expected CODE_EVIDENCE_FAILURE, got ${decision.label}`);

  const converge = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(converge.canConverge, false,
    `True unrecoverable MUST NOT be convergable: ${converge.reason}`);
  assert.ok(converge.reason.includes('no safe convergence'),
    `Reason should indicate no safe convergence: ${converge.reason}`);
});

test('G4 path D: true unrecoverable failure evidence stays blocking', () => {
  const task = makeTask({
    id: 'g4_pathD2', title: 'true unrecoverable failure evidence',
    result: {
      verification: { passed: false },
      acceptance_findings: [
        { severity: 'blocker', code: 'verification_failed', message: 'Test suite failed' },
      ],
    },
  });

  const decision = classifyCurrentBlockerTask(task);
  assert.equal(decision.blocks_current_work, true,
    'True unrecoverable failure evidence MUST stay blocking');
  assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE,
    `Expected FAILURE_EVIDENCE, got ${decision.label}`);

  const converge = canDeterministicallyConverge(task, emptyIndexes());
  assert.equal(converge.canConverge, false,
    `True failure evidence MUST NOT be convergable: ${converge.reason}`);
  assert.ok(converge.reason.includes('no safe convergence'),
    `Reason should indicate no safe convergence: ${converge.reason}`);
});

// ===========================================================================
// 6. Terminal anomaly count tracking -- before/after via manifest
// ===========================================================================

test('G4 terminal anomaly count: before/after manifest tracks convergence', async () => {
  const HEAD_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: CANONICAL_REPO, encoding: 'utf8',
  }).trim();

  // 5 convergable blockers + 2 unrecoverable = 7 total
  // Convergable: code evidence + reachable commit + tests (not verification.passed)
  // Unrecoverable: code evidence only (no reachable commit, no tests)
  const tasks = [
    makeTask({ id: 'g4_c1', goal_id: 'goal_c', result: { changed_files: ['a.mjs'], commit: HEAD_COMMIT, tests: 'pass', execution_cwd: CANONICAL_REPO } }),
    makeTask({ id: 'g4_c2', goal_id: 'goal_c', result: { changed_files: ['b.mjs'], commit: HEAD_COMMIT, tests: 'pass', execution_cwd: CANONICAL_REPO } }),
    makeTask({ id: 'g4_c3', goal_id: 'goal_c', result: { changed_files: ['c.mjs'], commit: HEAD_COMMIT, tests: 'pass', execution_cwd: CANONICAL_REPO } }),
    makeTask({ id: 'g4_c4', goal_id: 'goal_c', result: { changed_files: ['d.mjs'], commit: HEAD_COMMIT, tests: 'pass', execution_cwd: CANONICAL_REPO } }),
    makeTask({ id: 'g4_c5', goal_id: 'goal_c', result: { changed_files: ['e.mjs'], commit: HEAD_COMMIT, tests: 'pass', execution_cwd: CANONICAL_REPO } }),
    makeTask({ id: 'g4_u1', goal_id: 'goal_u', result: { changed_files: ['real-fail.mjs'] } }),
    makeTask({ id: 'g4_u2', goal_id: 'goal_u', result: { changed_files: ['another-fail.mjs'] } }),
  ];

  const store = makeMockStore(tasks);

  // Generate manifest
  const manifest = await generateBlockerManifest(store);

  // Before: all 7 are counted as blockers
  assert.equal(manifest.beforeCounts.current_blockers, 7,
    `Expected 7 terminal anomaly blockers before, got ${manifest.beforeCounts.current_blockers}`);

  // Apply convergence
  const after = await applyDeterministicConvergence(store);

  // After convergence: 5 converged, 2 remain
  assert.equal(after.converged.length, 5,
    `Expected 5 converged, got ${after.converged.length}`);
  assert.equal(after.afterCounts.current_blockers, 2,
    `Expected 2 terminal anomaly blockers after, got ${after.afterCounts.current_blockers}`);

  const delta = after.beforeCounts.current_blockers - after.afterCounts.current_blockers;
  assert.equal(delta, 5,
    `Expected delta of 5 (7->2), got ${delta}`);
});

// ===========================================================================
// 7. No fake zero guarantee -- preserve blocker policy
// ===========================================================================

test('G4 no fake zero: blocker manifest does not claim 0 when unrecoverable items remain', async () => {
  // Genuine unrecoverable failures: code evidence with no convergence path
  const tasks = [
    makeTask({ id: 'g4_nz1', title: 'real code failure',
      result: { changed_files: ['critical-fix.mjs'] },
    }),
    makeTask({ id: 'g4_nz2', title: 'real verification failure',
      result: { verification: { passed: false }, acceptance_findings: [{ severity: 'blocker', code: 'pipeline_gate_failed', message: 'Gate failed' }] },
    }),
  ];

  const store = makeMockStore(tasks);
  const manifest = await generateBlockerManifest(store);
  const after = await applyDeterministicConvergence(store);

  // Both are genuine unresolved failures -- must remain blocked
  assert.equal(after.converged.length, 0,
    'No items should be converged for genuine failures');
  assert.equal(after.afterCounts.current_blockers, 2,
    `current_blockers should be 2, got ${after.afterCounts.current_blockers}`);

  // Verify manifest shows them as unresolved_failure
  const unresolved = after.manifest.filter(e => e.category === MANIFEST_CATEGORIES.UNRESOLVED_FAILURE);
  assert.equal(unresolved.length, 2,
    `Expected 2 unresolved_failure entries, got ${unresolved.length}`);

  // Each unresolved entry must have evidence and reason
  for (const entry of unresolved) {
    assert.ok(entry.evidence, `Entry ${entry.task_id} must have evidence`);
    assert.ok(entry.reason, `Entry ${entry.task_id} must have reason`);
  }
});

console.log('ma12-g4-terminal-anomaly-convergence tests loaded');
