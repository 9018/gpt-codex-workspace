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

test('runAutoIntegrationCompletion completes already reachable commit with verification evidence', async () => {
  const fixture = createGitFixture('already-integrated');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 10;\n', 'task change');
    git(fixture.canonical, ['merge', '--ff-only', taskCommit]);
    let mergeCommands = 0;

    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_already_integrated' },
      goal: { id: 'goal_already_integrated' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false, pushed: true },
      config: { defaultBranch: 'main' },
      runCommandFn: async (cmd) => {
        const reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1];
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    mergeCommands = result.commands.filter((entry) => String(entry.cmd || '').includes('git merge --ff-only')).length;
    assert.equal(result.completed, true);
    assert.equal(result.reason, 'already_integrated_and_verified');
    assert.equal(result.merge.skipped, true);
    assert.equal(result.merge.already_integrated, true);
    assert.equal(mergeCommands, 0);
    assert.equal(result.verification_report.passed, true);
    assert.equal(result.verification_report.head, taskCommit);
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

test('analyzeAutoIntegrationCandidate allows verification-only with no_mutation evidence', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_verification_only', title: 'P0-UA6 full regression validation' },
    taskResult: baseTaskResult(null, {
      changed_files: [],
      commit: null,
      no_mutation: true,
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

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.reason, 'eligible');
  assert.equal(candidate.has_no_mutation_evidence, true);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'), false);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'commit_missing'), false);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'task_branch_missing'), false);
});

test('analyzeAutoIntegrationCandidate allows verification-only with repo_mutated false', () => {
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_repo_mutated_false', title: 'P0-UA6 full regression validation' },
    taskResult: baseTaskResult(null, {
      changed_files: [],
      commit: null,
      repo_mutated: false,
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

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.reason, 'eligible');
  assert.equal(candidate.has_no_mutation_evidence, true);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'), false);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'commit_missing'), false);
  assert.equal(candidate.blockers.some((entry) => entry.code === 'task_branch_missing'), false);
});

test('analyzeAutoIntegrationCandidate keeps generic builder changed_files empty blocked even with verification passed', () => {
  // A generic builder task with changed_files=[] but NO no_mutation/repo_mutated 
  // evidence should still be blocked. This distinguishes code_change tasks that
  // failed to produce changes from legitimate verification-only tasks.
  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_builder_noop2', title: 'Build feature with no changes' },
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
  assert.equal(candidate.has_no_mutation_evidence, false);
  assert.ok(candidate.blockers.some((entry) => entry.code === 'changed_files_missing'));
});

test('runAutoIntegrationCompletion completes verification-only no_mutation task without merge', async () => {
  const fixture = createGitFixture('no-mutation-verify');
  try {
    const canonicalHead = git(fixture.canonical, ['rev-parse', 'HEAD']);
    const commands = [];
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_no_mutation_verify' },
      goal: { id: 'goal_no_mutation_verify' },
      taskResult: baseTaskResult(null, {
        changed_files: [],
        commit: null,
        no_mutation: true,
        repo_mutated: false,
        verification: { 
          passed: true,
          profile: 'verification_only',
          commands: [{ cmd: 'npm --prefix backend test', exit_code: 0 }],
          findings: [],
        },
        reviewer_decision: { status: 'accepted', passed: true },
        integration: { status: 'not_required', required: false },
      }),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: { defaultBranch: 'main' },
      runCommandFn: async () => { return { returncode: 0, stdout: 'ok', stderr: '' }; },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.eligible, true);
    assert.equal(result.completed, true);
    assert.equal(result.reason, 'verification_only_completed');
    assert.equal(result.merge.attempted, false);
    assert.equal(result.merge.merged, true);
    assert.equal(result.merge.skipped, true);
    assert.equal(result.merge.already_integrated, true);
    assert.equal(result.verification_report.passed, true);
    assert.equal(result.verification_report.profile, 'verification_only');
    assert.equal(result.verification_report.head, canonicalHead);
    assert.equal(result.verification_report.dirty, false);
    // Canonical should remain unchanged
    assert.equal(git(fixture.canonical, ['rev-parse', 'HEAD']), canonicalHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
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

test('runAutoIntegrationCompletion keeps generated reports outside canonical repo by default', async () => {
  const fixture = createGitFixture('report-outside-canonical');
  try {
    const taskCommit = commit(fixture.worktree, 'src/app.mjs', 'export const value = 8;\n', 'task change');
    let reportPath = null;
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_report_outside' },
      goal: { id: 'goal_report_outside' },
      taskResult: baseTaskResult(taskCommit),
      resolvedRepo: resolvedRepo(fixture),
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: { defaultWorkspaceRoot: fixture.canonical },
      runCommandFn: async (cmd) => {
        reportPath = cmd.match(/--json-report\s+(\S+)/)?.[1] || null;
        writeFileSync(reportPath, JSON.stringify(passedReport({ head: taskCommit }), null, 2), 'utf8');
        return { returncode: 0, stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.completed, true);
    assert.ok(reportPath, 'report path should be generated');
    assert.equal(reportPath.startsWith(fixture.canonical + '/'), false, 'report path must not be inside canonical repo');
    assert.equal(git(fixture.canonical, ['status', '--porcelain']), '', 'canonical repo should remain clean after report generation');
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

// ============================================================
// P0-MA22 / P0-UA6: Verification-Only / No-Mutation Closure
// ============================================================

test('analyzeAutoIntegrationCandidate verification_only + changed_files=[] + commit=none + verification passed → is_diagnostic_no_mutation=true, no commit_missing blocker', () => {
  const taskResult = {
    status: 'completed',
    summary: 'verification-only task',
    operation_kind: 'verification_only',
    changed_files: [],
    commit: 'none',
    local_head: null,
    verification: { passed: true, findings: [] },
    reviewer_decision: { decision: { passed: true, status: 'accepted' } },
    acceptance_findings: [],
  };
  const integrationResult = { ok: true, status: 'branch_pushed', merged: false, pushed: true };
  const resolvedRepo = {
    repo_id: 'github.com/acme/repo',
    canonical_repo_path: '/tmp/fake-canonical',
    task_worktree_path: null,
    worktree_lifecycle: { mode: 'non_worktree', ok: true, worktree_path: null, branch_name: null, base_sha: null },
  };

  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_verification_only', goal_id: 'goal_verification_only' },
    taskResult,
    resolvedRepo,
    integrationResult,
  });

  // Should be eligible (no blockers for changed_files_missing, commit_missing, worktree)
  assert.equal(candidate.is_diagnostic_no_mutation, true, 'should identify as diagnostic no-mutation');
  assert.equal(candidate.has_no_mutation_evidence, false, 'no explicit no_mutation flag is set');
  assert.equal(candidate.eligible, true, 'should be eligible for auto integration completion');

  // Verify no changed_files_missing or commit_missing blockers
  const blockerCodes = candidate.blockers.map(b => b.code);
  assert.equal(blockerCodes.includes('changed_files_missing'), false, 'should not block on changed_files_missing for verification_only');
  assert.equal(blockerCodes.includes('commit_missing'), false, 'should not block on commit_missing for verification_only');
  assert.equal(blockerCodes.includes('worktree_mode_not_git_worktree'), false, 'should not block on worktree mode for verification_only');
  assert.equal(blockerCodes.includes('task_worktree_missing'), false, 'should not block on missing worktree for verification_only');
});

test('analyzeAutoIntegrationCandidate code_change + changed_files non-empty + commit missing → commit_missing blocker', () => {
  const taskResult = {
    status: 'completed',
    summary: 'code change task',
    operation_kind: 'code_change',
    changed_files: ['src/app.mjs'],
    commit: null,
    local_head: null,
    verification: { passed: true },
    reviewer_decision: { decision: { passed: true, status: 'accepted' } },
    acceptance_findings: [],
  };
  const integrationResult = { ok: true, status: 'branch_pushed', merged: false };
  const resolvedRepo = {
    repo_id: 'github.com/acme/repo',
    canonical_repo_path: '/tmp/fake-canonical',
    task_worktree_path: '/tmp/fake-worktree',
    worktree_lifecycle: { mode: 'git_worktree', ok: true, worktree_path: '/tmp/fake-worktree', branch_name: 'gptwork/task/code', base_sha: 'abc123' },
  };

  const candidate = analyzeAutoIntegrationCandidate({
    task: { id: 'task_code_change', goal_id: 'goal_code_change' },
    taskResult,
    resolvedRepo,
    integrationResult,
  });

  assert.equal(candidate.is_diagnostic_no_mutation, false, 'should NOT be diagnostic no-mutation');
  assert.equal(candidate.eligible, false, 'should NOT be eligible');
  const blockerCodes = candidate.blockers.map(b => b.code);
  assert.equal(blockerCodes.includes('commit_missing'), true, 'should block on commit_missing for code_change');
  assert.equal(blockerCodes.includes('changed_files_missing'), false, 'should not block on changed_files_missing because changed_files is non-empty');
});

test('runAutoIntegrationCompletion verification_only + changed_files=[] + commit=none + verification passed → verification_only_completed without commit required', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  // Create minimal git repo for canonical path
  const root = mkdtempSync(join(tmpdir(), 'gptwork-verification-only-'));
  const canonical = join(root, 'canonical');
  mkdirSync(canonical, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: canonical, encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: canonical, encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: canonical, encoding: 'utf8', stdio: 'ignore' });
  const base = execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: canonical, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  try {
    const result = await runAutoIntegrationCompletion({
      task: { id: 'task_verification_only_run', goal_id: 'goal_verification_only_run' },
      goal: { id: 'goal_verification_only_run' },
      taskResult: {
        status: 'completed',
        summary: 'verification-only run',
        operation_kind: 'verification_only',
        changed_files: [],
        commit: 'none',
        local_head: null,
        verification: { passed: true, commands: [{ cmd: 'check:syntax', exit_code: 0, passed: true }], profile: 'verification_only', findings: [] },
        reviewer_decision: { decision: { passed: true, status: 'accepted' } },
        acceptance_findings: [],
      },
      resolvedRepo: {
        repo_id: 'github.com/acme/repo',
        canonical_repo_path: canonical,
        task_worktree_path: null,
        worktree_lifecycle: { mode: 'non_worktree', ok: true, worktree_path: null, branch_name: null, base_sha: base },
      },
      integrationResult: { ok: true, status: 'branch_pushed', merged: false },
      config: {},
      runCommandFn: async () => ({ returncode: 0, stdout: '', stderr: '' }),
    });

    assert.equal(result.attempted, true, 'should be attempted');
    assert.equal(result.completed, true, 'should complete without a real commit');
    assert.equal(result.reason, 'verification_only_completed', 'reason should be verification_only_completed');
    assert.equal(result.eligible, true, 'should be eligible');
    assert.equal(result.merge.skipped, true, 'merge should be skipped (no real integration needed)');
    assert.equal(result.merge.merged, true, 'merge should report as merged (no-op)');
    assert.equal(result.verification_report.passed, true, 'verification report should be passed');
    assert.equal(result.verification_report.profile, 'verification_only', 'verification profile should be verification_only');
    assert.equal(result.blockers.length, 0, 'should have no blockers');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
