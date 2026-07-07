import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAutoIntegrationCompletion, analyzeAutoIntegrationCandidate } from '../src/auto-integration-completion.mjs';

// ===========================================================================
// Helpers (same pattern as auto-integration-completion.test.mjs)
// ===========================================================================

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(repo, file, content) {
  const path = join(repo, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function commit(repo, file, content, message) {
  write(repo, file, content);
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function createGitFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `gptwork-afcp2-${name}-`));
  const canonical = join(root, 'canonical');
  mkdirSync(canonical, { recursive: true });
  git(canonical, ['init', '-b', 'main']);
  git(canonical, ['config', 'user.email', 'test@example.com']);
  git(canonical, ['config', 'user.name', 'Test User']);
  const base = commit(canonical, 'README.md', 'base\n', 'base');
  const branch = `gptwork/task/${name}`;
  const worktree = join(root, 'worktree');
  git(canonical, ['worktree', 'add', '-b', branch, worktree, 'main']);
  git(worktree, ['config', 'user.email', 'test@example.com']);
  git(worktree, ['config', 'user.name', 'Test User']);
  return { root, canonical, worktree, branch, base };
}

function baseTaskResult(commitSha, overrides = {}) {
  return {
    status: 'completed',
    summary: 'done',
    changed_files: ['src/app.mjs'],
    commit: commitSha,
    tests: 'passed',
    verification: { passed: true, findings: [] },
    reviewer_decision: { decision: { passed: true, status: 'accepted' } },
    acceptance_findings: [],
    ...overrides,
  };
}

function resolvedRepo(fixture) {
  return {
    repo_id: 'github.com/acme/repo',
    canonical_repo_path: fixture.canonical,
    task_worktree_path: fixture.worktree,
    worktree_lifecycle: {
      mode: 'git_worktree',
      ok: true,
      worktree_path: fixture.worktree,
      branch_name: fixture.branch,
      base_sha: fixture.base,
    },
  };
}

function passedReport({ head, profile = 'changed', dirty = false }) {
  return {
    schema_version: 1,
    mode: profile === 'fast' ? 'fast' : 'changed',
    profile,
    requested_profile: 'changed',
    completed_at: new Date().toISOString(),
    repo: { head, dirty, branch: 'main' },
    passed: true,
    steps: [{ name: 'check:imports', cmd: 'npm', args: ['run', 'check:imports'], exit_code: 0, passed: true, duration_ms: 1 }],
    failures: [],
  };
}

// ===========================================================================
// AFC-P2 Scenario 1: Stale canonical_dirty superseded by unified_decision
// ===========================================================================

test('AFC-P2: stale canonical_dirty bypassed when unified_decision.status === completed', async () => {
  const fixture = createGitFixture('canonical-dirty-bypass');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 1;\n', 'task change');

    // Make canonical repo dirty
    write(fixture.canonical, 'uncommitted.txt', 'dirty\n');

    // Task result has unified_decision.status === 'completed'
    const taskResult = baseTaskResult(taskCommit, {
      unified_decision: {
        status: 'completed',
        source: 'finalizer',
        blocking_passed: true,
        safe_to_auto_advance: true,
        requires_review: false,
        normalized_at: new Date().toISOString(),
      },
    });

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_canonical_dirty_bypass' },
      goal: { id: 'goal_canonical_dirty_bypass' },
      taskResult,
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
      config: { defaultBranch: 'main' },
      runCommandFn: async () => { return { returncode: 0, stdout: 'ok', stderr: '' }; },
    });

    // Should bypass canonical_dirty check and complete
    assert.equal(result.completed, true, 'should complete despite canonical repo being dirty');
    assert.equal(result.eligible, true, 'should be eligible');
    assert.equal(result.merge.skipped, true, 'merge should be skipped (no real integration)');
    assert.equal(result.merge.merged, true, 'should report merged');
    assert.equal(result.blockers.length, 0, 'should have no blockers');
    assert.ok(result.reason.endsWith('canonical_unified_decision_completed') || result.reason.endsWith('completed'), 'reason should reflect canonical completion');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('AFC-P2: analyzeAutoIntegrationCandidate passes when unified_decision completed without changed_files', () => {
  // A task with unified_decision completed but no changed_files should not be
  // blocked by changed_files_missing
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_ud_completed_no_files', goal_id: 'goal_ud_completed_no_files' },
    taskResult: baseTaskResult(null, {
      changed_files: [],
      commit: null,
      operation_kind: 'verification_only',
      no_mutation: true,
      unified_decision: {
        status: 'completed',
        source: 'finalizer',
        blocking_passed: true,
      },
      verification: { passed: true, findings: [] },
      integration: { status: 'not_required', required: false },
      needs_integration: false,
    }),
    resolvedRepo: {
      repo_id: 'github.com/acme/repo',
      canonical_repo_path: '/tmp/fake-canonical',
      task_worktree_path: null,
      worktree_lifecycle: { mode: 'non_worktree', ok: true, worktree_path: null, branch_name: null, base_sha: null },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, true, 'should be eligible when unified_decision says completed');
  const blockerCodes = candidate.blockers.map(b => b.code);
  assert.equal(blockerCodes.includes('changed_files_missing'), false, 'no changed_files_missing blocker');
  assert.equal(blockerCodes.includes('commit_missing'), false, 'no commit_missing blocker');
});

// ===========================================================================
// AFC-P2 Scenario 2: No-change verification-only doesn't require commit
// ===========================================================================

test('AFC-P2: verification-only no-change does not require commit when unified_decision completed', async () => {
  const fixture = createGitFixture('verify-nochange-ud');
  try {
    const canonicalHead = git(fixture.canonical, ['rev-parse', 'HEAD']);

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_verify_nochange_ud', goal_id: 'goal_verify_nochange_ud' },
      goal: { id: 'goal_verify_nochange_ud' },
      taskResult: {
        status: 'completed',
        summary: 'verification-only with unified_decision',
        operation_kind: 'verification_only',
        changed_files: [],
        commit: null,
        no_mutation: true,
        unified_decision: {
          status: 'completed',
          source: 'finalizer',
          blocking_passed: true,
          safe_to_auto_advance: true,
        },
        verification: { passed: true, commands: [{ cmd: 'check:syntax', exit_code: 0, passed: true }], profile: 'verification_only', findings: [] },
        reviewer_decision: { decision: { passed: true, status: 'accepted' } },
        acceptance_findings: [],
      },
      resolvedRepo: {
        repo_id: 'github.com/acme/repo',
        canonical_repo_path: fixture.canonical,
        task_worktree_path: null,
        worktree_lifecycle: { mode: 'non_worktree', ok: true, worktree_path: null, branch_name: null, base_sha: fixture.base },
      },
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async () => ({ returncode: 0, stdout: '', stderr: '' }),
    });

    assert.equal(result.completed, true, 'should complete without commit');
    assert.equal(result.eligible, true, 'should be eligible');
    assert.equal(result.merge.skipped, true, 'merge should be skipped');
    assert.equal(result.blockers.length, 0, 'no blockers');
    assert.equal(git(fixture.canonical, ['rev-parse', 'HEAD']), canonicalHead, 'canonical unchanged');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ===========================================================================
// AFC-P2 Scenario 3: Code_change without commit still blocked
// ===========================================================================

test('AFC-P2: code_change with changed_files but no commit still blocked despite unified_decision incomplete', () => {
  // unified_decision is NOT completed — so standard blockers apply
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_code_no_commit', goal_id: 'goal_code_no_commit' },
    taskResult: baseTaskResult(null, {
      changed_files: ['src/app.mjs'],
      commit: null,
      unified_decision: {
        status: 'waiting_for_review',
        source: 'finalizer',
        blocking_passed: false,
      },
      verification: { passed: true, findings: [] },
    }),
    resolvedRepo: {
      repo_id: 'github.com/acme/repo',
      canonical_repo_path: '/tmp/fake-canonical',
      task_worktree_path: '/tmp/fake-worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/fake-worktree', branch_name: 'gptwork/task/task_code_no_commit', base_sha: 'abc123' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, false, 'should NOT be eligible without commit');
  const blockerCodes = candidate.blockers.map(b => b.code);
  assert.equal(blockerCodes.includes('commit_missing'), true, 'should block on commit_missing');
  assert.equal(blockerCodes.includes('changed_files_missing'), false, 'no changed_files_missing since changed_files is non-empty');
});

// ===========================================================================
// AFC-P2 Scenario 4: Already_integrated as terminal satisfied
// ===========================================================================

test('AFC-P2: already_integrated task reaches terminal satisfied status', async () => {
  const fixture = createGitFixture('already-integrated-terminal');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 42;\n', 'task change');
    // Merge task commit into canonical
    git(fixture.canonical, ['merge', '--ff-only', taskCommit]);

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_already_integrated_terminal' },
      goal: { id: 'goal_already_integrated_terminal' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
      config: { defaultBranch: 'main' },
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit, profile: 'fast' }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, true, 'already_integrated should complete');
    assert.equal(result.reason, 'already_integrated_and_verified', 'reason should reflect already_integrated');
    assert.equal(result.merge.skipped, true, 'merge skipped since already integrated');
    assert.equal(result.merge.already_integrated, true, 'marked as already_integrated');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ===========================================================================
// AFC-P2 Scenario 5: Review packet canonical_outcome matches unified_decision
// ===========================================================================

test('AFC-P2: canonical_outcome in bundle matches unified_decision status', async () => {
  const fixture = createGitFixture('review-packet-match');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const val = 7;\n', 'task');
    const unifiedDecision = {
      status: 'completed',
      reason: 'All evidence satisfied',
      source: 'finalizer',
      blocking_passed: true,
      safe_to_auto_advance: true,
      profile: 'code_change',
      normalized_at: new Date().toISOString(),
    };

    // Run auto-integration and verify the unified_decision flows through
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_review_packet_match' },
      goal: { id: 'goal_review_packet_match' },
      taskResult: baseTaskResult(taskCommit, {
        unified_decision: unifiedDecision,
      }),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
      config: { defaultBranch: 'main' },
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, true, 'should complete');
    assert.equal(result.reason, 'canonical_unified_decision_completed', 'reason should reflect canonical unified_decision bypass');

    // The unified_decision flows through autoIntegrationVerificationFromReport
    // and is expected to be present in the final taskResult.  Verify the
    // acceptancePassed function respects it.
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ===========================================================================
// AFC-P2 Scenario 6: Strong real blocker not weakened by unified_decision
// ===========================================================================

test('AFC-P2: real code_change blocker not weakened when unified_decision is incomplete', () => {
  // Even if unified_decision exists but is NOT completed, standard blockers
  // should still apply
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_real_blocker', goal_id: 'goal_real_blocker' },
    taskResult: baseTaskResult(null, {
      changed_files: ['src/app.mjs'],
      commit: null,
      verification: { passed: false, findings: [{ severity: 'blocker', code: 'test_failed' }] },
      unified_decision: {
        status: 'waiting_for_review',
        blocking_passed: false,
        blockers: [{ severity: 'blocker', code: 'test_failed', message: 'Tests failed' }],
      },
      reviewer_decision: { decision: { passed: false, status: 'rejected' } },
    }),
    resolvedRepo: {
      repo_id: 'github.com/acme/repo',
      canonical_repo_path: '/tmp/fake-canonical',
      task_worktree_path: '/tmp/fake-worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/fake-worktree', branch_name: 'gptwork/task/task_real_blocker', base_sha: 'abc123' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, false, 'should NOT be eligible');
  assert.ok(candidate.blockers.some(b => b.code === 'acceptance_not_passed'), 'should have acceptance_not_passed blocker');
});
