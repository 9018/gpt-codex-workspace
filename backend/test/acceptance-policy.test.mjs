import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAcceptance,
  buildReviewerDecision,
  buildWorktreeReliabilityFindings,
  ACCEPTANCE_SEVERITIES,
} from '../src/acceptance-policy.mjs';

test('acceptance policy blocks blocker findings and creates repair proposal', () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'blocker', code: 'dirty_worktree_after_codex', message: 'Worktree is dirty' },
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.status, 'needs_fix');
  assert.equal(decision.should_enter_review, false, 'critical implementation failures should route to repair, not manual review');
  assert.equal(decision.repair_proposals.length, 1);
  assert.match(decision.repair_proposals[0].title, /dirty_worktree_after_codex/);
  assert.equal(decision.next_tasks[0].priority, 'P0');
});

test('acceptance policy allows minor and followup findings while emitting next tasks', () => {
  const decision = evaluateAcceptance({
    findings: [
      { severity: 'minor', code: 'docs_gap', message: 'Docs need a later pass' },
      { severity: 'followup', code: 'real_worktree_lifecycle', message: 'Implement git worktree add/remove lifecycle' },
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.status, 'accepted_with_followups');
  assert.equal(decision.should_enter_review, false);
  assert.deepEqual(decision.repair_proposals, []);
  assert.deepEqual(decision.next_tasks.map((task) => task.priority), ['P1', 'P2']);
});

test('reviewer decision is a final verdict, not only a summary', () => {
  const result = {
    status: 'completed',
    summary: 'Implemented feature',
    changed_files: ['backend/src/example.mjs'],
    tests: 'node --test passed',
    commit: 'abc123',
    remote_head: 'def456',
  };

  const reviewer = buildReviewerDecision({
    result,
    findings: [{ severity: 'followup', code: 'cleanup', message: 'Cleanup can wait' }],
  });

  assert.equal(reviewer.role, 'acceptance_agent');
  assert.equal(reviewer.decision.status, 'accepted_with_followups');
  assert.equal(reviewer.decision.passed, true);
  assert.ok(Array.isArray(reviewer.acceptance_findings));
  assert.ok(Array.isArray(reviewer.next_tasks));
  assert.notEqual(reviewer.summary, result.summary, 'reviewer summary must be derived from acceptance verdict');
});

test('acceptance severity enum documents blocker major minor followup', () => {
  assert.deepEqual(ACCEPTANCE_SEVERITIES, ['blocker', 'major', 'minor', 'followup']);
});

test('worktree reliability checks are first-class acceptance findings', () => {
  const findings = buildWorktreeReliabilityFindings({
    git_worktree_created: false,
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: false,
    worktree_cleanup_lifecycle: false,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings.map((finding) => finding.code), [
    'git_worktree_not_created',
    'task_processor_lock_not_repo_id_driven',
    'worktree_cleanup_lifecycle_missing',
  ]);
  assert.equal(findings[0].severity, 'followup', 'metadata-only worktree lifecycle is tracked as followup until isolation is claimed');
  assert.equal(findings[1].severity, 'blocker');
  assert.equal(findings[2].severity, 'major');
});

test('worktree reliability accepts reused real git worktree lifecycle without metadata-only finding', () => {
  const findings = buildWorktreeReliabilityFindings({
    worktree_lifecycle: {
      mode: 'git_worktree',
      ok: true,
      git_worktree_created: false,
      existing: true,
      cleanup_supported: true,
    },
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: true,
    worktree_cleanup_lifecycle: true,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings, []);
});

test('worktree reliability blocks failed git worktree lifecycle instead of auto-accepting metadata-only followup', () => {
  const findings = buildWorktreeReliabilityFindings({
    worktree_lifecycle: {
      mode: 'git_worktree',
      ok: false,
      error: 'worktree add failed: fatal',
      cleanup_supported: true,
    },
    repo_lock_atomic: true,
    queue_dirty_check_repo_id_driven: true,
    task_processor_lock_repo_id_driven: true,
    worktree_cleanup_lifecycle: true,
    crash_recovery_supported: true,
  });

  assert.deepEqual(findings.map((finding) => finding.code), ['git_worktree_lifecycle_failed']);
  assert.equal(findings[0].severity, 'blocker');
});
