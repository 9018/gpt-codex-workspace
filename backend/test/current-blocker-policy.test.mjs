import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  CURRENT_WORK_DECISION_LABELS,
  classifyCurrentBlockerTask,
  isCommitAncestorOfHead,
} from '../src/current-blocker-policy.mjs';

test('exports frozen canonical current-work decision labels', () => {
  assert.equal(Object.isFrozen(CURRENT_WORK_DECISION_LABELS), true);
  assert.deepEqual(CURRENT_WORK_DECISION_LABELS, {
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
});

test('classifyCurrentBlockerTask labels active execution statuses', () => {
  for (const status of ['assigned', 'queued', 'running', 'waiting_for_lock', ' WAITING_FOR_LOCK ']) {
    assert.deepEqual(classifyCurrentBlockerTask({ status }), {
      label: CURRENT_WORK_DECISION_LABELS.ACTIVE,
      status: status.trim?.().toLowerCase?.() ?? status,
      result_shape: 'no_result',
      blocks_current_work: true,
    });
  }
});

test('classifyCurrentBlockerTask labels review and integration statuses distinctly', () => {
  assert.deepEqual(classifyCurrentBlockerTask({ status: 'waiting_for_review' }), {
    label: CURRENT_WORK_DECISION_LABELS.REVIEW,
    status: 'waiting_for_review',
    result_shape: 'no_result',
    blocks_current_work: true,
  });
  assert.deepEqual(classifyCurrentBlockerTask({ status: 'waiting_for_integration' }), {
    label: CURRENT_WORK_DECISION_LABELS.INTEGRATION,
    status: 'waiting_for_integration',
    result_shape: 'no_result',
    blocks_current_work: true,
  });
});

test('classifyCurrentBlockerTask labels completed tasks as non-blocking completed', () => {
  assert.deepEqual(classifyCurrentBlockerTask({ status: ' completed ', result: { verification: { passed: true } } }), {
    label: CURRENT_WORK_DECISION_LABELS.COMPLETED,
    status: 'completed',
    result_shape: 'completion_evidence',
    blocks_current_work: false,
  });
});

test('classifyCurrentBlockerTask labels explicit resolved-by options before failure evidence', () => {
  for (const result of [
    { resolved_by_task_id: 'task_successor', changed_files: ['backend/src/a.mjs'] },
    { superseded_by_task_id: 'task_successor' },
    { resolved_legacy: true },
    { noop: true },
  ]) {
    const decision = classifyCurrentBlockerTask({ status: 'failed', result });
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS);
    assert.equal(decision.blocks_current_work, false);
  }
});

test('classifyCurrentBlockerTask labels provider-empty terminal failures as non-blocking', () => {
  for (const task of [
    { status: 'failed', result: null },
    { status: 'failed', result: { failure_class: 'result_missing' } },
    { status: 'timed_out', result: { kind: 'codex_timeout' } },
    { status: 'failed', result: { kind: 'codex_failed' } },
  ]) {
    const decision = classifyCurrentBlockerTask(task);
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.PROVIDER_EMPTY);
    assert.equal(decision.blocks_current_work, false);
  }
});

test('classifyCurrentBlockerTask labels terminal code evidence failures as blocking', () => {
  for (const result of [
    { changed_files: ['backend/src/dirty.mjs'] },
    { tests: 'node --test failed' },
    { commit: 'abc123' },
  ]) {
    const decision = classifyCurrentBlockerTask({ status: 'failed', result });
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.CODE_EVIDENCE_FAILURE);
    assert.equal(decision.blocks_current_work, true);
    assert.equal(decision.result_shape, 'code_evidence');
  }
});

test('classifyCurrentBlockerTask labels terminal failure evidence as blocking', () => {
  for (const result of [
    { verification: { passed: false } },
    { findings: [{ code: 'blocker', message: 'Broken' }] },
    { commands: [{ cmd: 'npm test', exit_code: 1 }] },
    { failure_class: 'verification_failed' },
    { kind: 'verification_failed' },
    { requires_review: true },
  ]) {
    const decision = classifyCurrentBlockerTask({ status: 'failed', result });
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.FAILURE_EVIDENCE);
    assert.equal(decision.blocks_current_work, true);
    assert.equal(decision.result_shape, 'failure_evidence');
  }
});

test('classifyCurrentBlockerTask keeps resolved failure evidence non-blocking', () => {
  for (const result of [
    { resolved_by_task_id: 'task_successor', verification: { passed: false } },
    { superseded_by_task_id: 'task_successor', findings: [{ code: 'old' }] },
    { noop: true, commands: [{ cmd: 'npm test', exit_code: 1 }] },
  ]) {
    const decision = classifyCurrentBlockerTask({ status: 'failed', result });
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.RESOLVED_BY_OPTIONS);
    assert.equal(decision.blocks_current_work, false);
  }
});

test('classifyCurrentBlockerTask labels unknown statuses as non-blocking unknown status', () => {
  for (const task of [{ status: 'needs_triage' }, { status: '' }, {}, null]) {
    const decision = classifyCurrentBlockerTask(task);
    assert.equal(decision.label, CURRENT_WORK_DECISION_LABELS.UNKNOWN_STATUS);
    assert.equal(decision.blocks_current_work, false);
  }
});

test('classifyCurrentBlockerTask is deterministic and does not mutate input', () => {
  const task = Object.freeze({
    status: 'failed',
    result: Object.freeze({ changed_files: Object.freeze(['backend/src/a.mjs']) }),
  });

  const first = classifyCurrentBlockerTask(task);
  const second = classifyCurrentBlockerTask(task);

  assert.deepEqual(first, second);
  assert.deepEqual(task, {
    status: 'failed',
    result: { changed_files: ['backend/src/a.mjs'] },
  });
});


test('isCommitAncestorOfHead falls back from stale worktree to canonical repo path', () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-current-blocker-'));
  const repo = join(root, 'repo');
  const other = join(root, 'other');
  mkdirSync(repo);
  mkdirSync(other);
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'a'], { cwd: repo, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init'], { cwd: other, stdio: 'ignore' });
  const previousDefaultRepoPath = process.env.GPTWORK_DEFAULT_REPO_PATH;
  try {
    process.env.GPTWORK_DEFAULT_REPO_PATH = repo;
    assert.equal(isCommitAncestorOfHead(commit.slice(0, 7), other), true);
  } finally {
    if (previousDefaultRepoPath === undefined) {
      delete process.env.GPTWORK_DEFAULT_REPO_PATH;
    } else {
      process.env.GPTWORK_DEFAULT_REPO_PATH = previousDefaultRepoPath;
    }
  }
});


test('verified readonly review is excluded', () => {
  const d = classifyCurrentBlockerTask({ status: 'waiting_for_review', result: { summary: 'readonly validation ok', changed_files: [], verification: { passed: true } } });
  assert.equal(d.blocks_current_work, false);
});

test('changed review is retained', () => {
  const d = classifyCurrentBlockerTask({ status: 'waiting_for_review', result: { summary: 'changed code and tests passed', changed_files: ['backend/src/example.mjs'], verification: { passed: true } } });
  assert.equal(d.blocks_current_work, true);
});
