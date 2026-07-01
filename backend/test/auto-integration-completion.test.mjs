import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { analyzeAutoIntegrationCandidate, classifyIntegrationQueueResult, runAutoIntegrationCompletion } from '../src/auto-integration-completion.mjs';

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
  const root = mkdtempSync(join(tmpdir(), `gptwork-auto-int-${name}-`));
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

test('runAutoIntegrationCompletion ff-only merges branch_pushed task and validates post-merge report', async () => {
  const fixture = createGitFixture('success');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 1;\n', 'task change');
    const commands = [];
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_success' },
      goal: { id: 'goal_success' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
      config: { defaultBranch: 'main' },
      runCommandFn: async (cmd, cwd) => {
        commands.push({ cmd, cwd });
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: git(fixture.canonical, ['rev-parse', 'HEAD']) }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.eligible, true);
    assert.equal(result.completed, true);
    assert.equal(result.reason, 'ff_only_merged_and_verified');
    assert.equal(result.base_sha, fixture.base);
    assert.equal(result.commit, taskCommit);
    assert.equal(result.merge.mode, 'ff_only');
    assert.equal(result.merge.merged, true);
    assert.equal(result.verification_report.passed, true);
    assert.equal(result.verification_report.head, taskCommit);
    assert.equal(result.verification_report.dirty, false);
    assert.equal(git(fixture.canonical, ['rev-parse', 'HEAD']), taskCommit);
    assert.ok(commands[0].cmd.includes('--profile changed'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runAutoIntegrationCompletion refuses dirty canonical repo without merging', async () => {
  const fixture = createGitFixture('dirty');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 2;\n', 'task change');
    write(fixture.canonical, 'dirty.txt', 'dirty\n');
    let commandCount = 0;
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_dirty' },
      goal: { id: 'goal_dirty' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async () => { commandCount += 1; return { returncode: 0, stdout: '', stderr: '' }; },
    });

    assert.equal(result.completed, false);
    assert.equal(result.reason, 'canonical_dirty');
    assert.equal(result.blockers[0].code, 'canonical_dirty');
    assert.equal(result.merge.attempted, false);
    assert.equal(git(fixture.canonical, ['rev-parse', 'HEAD']), fixture.base);
    assert.equal(commandCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runAutoIntegrationCompletion handles clean divergent branch fallback', async () => {
  const fixture = createGitFixture('diverged');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 3;\n', 'task change');
    commit(fixture.canonical, 'src/main.mjs', 'export const main = true;\n', 'main change');
    const canonicalHead = git(fixture.canonical, ['rev-parse', 'HEAD']);

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_diverged', title: 'Diverged clean task' },
      goal: { id: 'goal_diverged' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async (cmd) => { const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1]; writeFileSync(reportPath, JSON.stringify(passedReport({ head: git(fixture.canonical, ['rev-parse', 'HEAD']) }), null, 2), 'utf8'); return { returncode: 0, stdout: 'ok', stderr: '' }; },
    });

    assert.equal(result.completed, true);
    assert.equal(result.reason, 'cherry_pick_merged_and_verified');
    assert.equal(result.merge.attempted, true);
    assert.equal(result.merge.merged, true);
    assert.notEqual(git(fixture.canonical, ['rev-parse', 'HEAD']), canonicalHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runAutoIntegrationCompletion reports merged_but_verification_failed when post-merge report fails', async () => {
  const fixture = createGitFixture('report-failed');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 4;\n', 'task change');
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_report_failed' },
      goal: { id: 'goal_report_failed' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        const report = { ...passedReport({ head: taskCommit }), passed: false, failures: [{ name: 'failed' }] };
        writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        return { returncode: 1, stdout: '', stderr: 'failed' };
      },
    });

    assert.equal(result.completed, false);
    assert.equal(result.reason, 'post_merge_verification_failed');
    assert.equal(result.merged_but_verification_failed, true);
    assert.equal(result.blockers[0].code, 'post_merge_verification_failed');
    assert.equal(git(fixture.canonical, ['rev-parse', 'HEAD']), taskCommit);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('analyzeAutoIntegrationCandidate rejects branch_pushed task without passed acceptance', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_no_acceptance' },
    taskResult: baseTaskResult('abc123', {
      reviewer_decision: { decision: { passed: false } },
      verification: { passed: false, findings: [] },
    }),
    resolvedRepo: {
      canonical_repo_path: '/tmp/canonical',
      task_worktree_path: '/tmp/worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/worktree' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, false);
  assert.equal(candidate.reason, 'acceptance_not_passed');
  assert.equal(candidate.blockers[0].code, 'acceptance_not_passed');
});

test('analyzeAutoIntegrationCandidate allows repair_noop already-integrated evidence with changed_files empty', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_78ee_like', title: 'Repair: P0 auto convergence routing', repair_of_task_id: 'task_original' },
    taskResult: baseTaskResult(null, {
      summary: 'Original changes already integrated into main; affected files match main exactly; tests pass.',
      changed_files: [],
      commit: null,
      repair_noop: true,
      already_integrated: true,
      no_change_repair_evidence: {
        affected_files: ['backend/src/goal-convergence.mjs'],
        files_match_canonical: true,
        diff_empty: true,
      },
      verification: { passed: true, commands: [{ cmd: 'npm --prefix backend run check:syntax', exit_code: 0 }], findings: [] },
      reviewer_decision: { status: 'accepted', passed: true },
      integration: { status: 'not_required', required: false },
      needs_integration: false,
    }),
    resolvedRepo: {
      canonical_repo_path: '/tmp/canonical',
      task_worktree_path: '/tmp/worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/worktree' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false, already_integrated: true },
  });

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.reason, 'eligible');
  assert.equal(candidate.no_change_repair.completion_eligible, true);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'), false);
});

test('analyzeAutoIntegrationCandidate keeps generic builder changed_files empty blocked', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_builder_noop', title: 'Build feature' },
    taskResult: baseTaskResult(null, {
      changed_files: [],
      commit: null,
      verification: { passed: true, commands: [{ cmd: 'npm test', exit_code: 0 }], findings: [] },
      reviewer_decision: { status: 'accepted', passed: true },
      integration: { status: 'not_required', required: false },
    }),
    resolvedRepo: {
      canonical_repo_path: '/tmp/canonical',
      task_worktree_path: '/tmp/worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/worktree' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, false);
  assert.ok(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'));
});

test('analyzeAutoIntegrationCandidate blocks repair_noop without passed verification', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_repair_no_verify', title: 'Repair: no changes needed', repair_of_task_id: 'task_original' },
    taskResult: baseTaskResult(null, {
      changed_files: [],
      commit: null,
      repair_noop: true,
      already_integrated: true,
      no_change_repair_evidence: { affected_files: ['backend/src/x.mjs'], files_match_canonical: true },
      verification: { passed: null, commands: [], findings: [] },
      reviewer_decision: { status: 'accepted', passed: true },
      integration: { status: 'not_required', required: false },
      needs_integration: false,
    }),
    resolvedRepo: {
      canonical_repo_path: '/tmp/canonical',
      task_worktree_path: '/tmp/worktree',
      worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/worktree' },
    },
    integrationResult: { ok: true, status: 'branch_pushed', merged: false },
  });

  assert.equal(candidate.eligible, false);
  assert.equal(candidate.no_change_repair.reason, 'verification_not_passed');
  assert.ok(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'));
});

test('classifyIntegrationQueueResult marks merged and skipped as terminal completion', () => {
  assert.deepEqual(classifyIntegrationQueueResult({ ok: true, status: 'merged', merged: true }), {
    kind: 'terminal_completed',
    task_status: 'completed',
    should_attempt_auto_completion: false,
    should_attempt_repair: false,
  });
  assert.equal(classifyIntegrationQueueResult({ ok: true, status: 'skipped' }).task_status, 'completed');
});

test('classifyIntegrationQueueResult separates auto-completion candidates from repairable failures', () => {
  const pushed = classifyIntegrationQueueResult({ ok: true, status: 'branch_pushed', merged: false });
  assert.equal(pushed.kind, 'auto_completion_candidate');
  assert.equal(pushed.task_status, null);
  assert.equal(pushed.should_attempt_auto_completion, true);
  assert.equal(pushed.should_attempt_repair, false);

  const conflict = classifyIntegrationQueueResult({ ok: false, status: 'conflict' });
  assert.equal(conflict.kind, 'repairable_failure');
  assert.equal(conflict.task_status, null);
  assert.equal(conflict.should_attempt_auto_completion, false);
  assert.equal(conflict.should_attempt_repair, true);
});

test('runAutoIntegrationCompletion returns already_integrated evidence when canonical already contains task commit', async () => {
  const fixture = createGitFixture('already');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 5;\n', 'task change');
    git(fixture.canonical, ['merge', '--ff-only', taskCommit]);

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_already' },
      goal: { id: 'goal_already' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit, profile: 'fast' }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, true);
    assert.equal(result.reason, 'already_integrated_and_verified');
    assert.equal(result.merge.skipped, true);
    assert.equal(result.verification_report.profile, 'fast');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runAutoIntegrationCompletion records fallback when changed-profile verification is unavailable', async () => {
  const fixture = createGitFixture('fallback');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 6;\n', 'task change');
    let attempts = 0;
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_fallback' },
      goal: { id: 'goal_fallback' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async (cmd) => {
        attempts += 1;
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        if (attempts === 1) return { returncode: 1, stdout: '', stderr: 'changed unsupported' };
        assert.ok(cmd.includes('--fast'));
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit, profile: 'fast' }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, true);
    assert.equal(result.verification_report.profile, 'fast');
    assert.deepEqual(result.warnings, ['changed_profile_verification_failed; fell back to fast profile']);
    assert.equal(attempts, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runAutoIntegrationCompletion fails if report head does not match canonical HEAD after merge', async () => {
  const fixture = createGitFixture('head-mismatch');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 7;\n', 'task change');
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_head_mismatch' },
      goal: { id: 'goal_head_mismatch' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: fixture.base }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, false);
    assert.equal(result.reason, 'post_merge_verification_failed');
    assert.equal(result.verification_report_validation.reason, 'head_mismatch');
    assert.equal(result.merged_but_verification_failed, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
