import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStateAssertions } from '../src/assertions/state-assertion-runner.mjs';

async function makeRepo(t) {
  const repoPath = await mkdtemp(join(tmpdir(), 'gptwork-state-assertions-'));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  await writeFile(join(repoPath, 'README.md'), 'hello\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  return { repoPath, head };
}

test('runs repo, file, commit, integration, and report assertions', async (t) => {
  const { repoPath, head } = await makeRepo(t);
  await mkdir(join(repoPath, '.gptwork', 'reports'), { recursive: true });
  const fileContent = 'file evidence body\n';
  await writeFile(join(repoPath, 'out.txt'), fileContent, 'utf8');
  const sha256 = createHash('sha256').update(fileContent).digest('hex');
  const reportPath = join(repoPath, '.gptwork', 'reports', 'release.json');
  await writeFile(reportPath, JSON.stringify({ passed: true, repo: { head, dirty: false } }), 'utf8');

  const result = await runStateAssertions({
    repoPath,
    contract: { state_assertions: [
      { kind: 'repo_clean' },
      { kind: 'file_exists', path: 'out.txt' },
      { kind: 'file_min_bytes', path: 'out.txt', min_bytes: 5 },
      { kind: 'file_sha256_matches', path: 'out.txt', sha256 },
      { kind: 'result_has_changed_files' },
      { kind: 'commit_present' },
      { kind: 'commit_reachable' },
      { kind: 'integration_satisfied' },
      { kind: 'release_report_passed' },
      { kind: 'report_head_matches' },
      { kind: 'report_repo_clean' },
    ] },
    result: {
      changed_files: ['out.txt'],
      commit: head,
      verification: { report_path: reportPath },
      integration: { merged: true, status: 'merged' },
    },
    config: { repoStatusPorcelain: '', repoHead: head },
  });

  assert.equal(result.passed, true);
  assert.equal(result.assertions.length, 11);
  assert.deepEqual(result.failures, []);
});

test('runs runtime/admin/diagnostic/cleanup assertions', async (t) => {
  const { repoPath } = await makeRepo(t);
  const result = await runStateAssertions({
    repoPath,
    contract: { state_assertions: [
      { kind: 'health_check_passed' },
      { kind: 'runtime_commit_matches' },
      { kind: 'process_restarted' },
      { kind: 'port_listening', port: 8080 },
      { kind: 'audit_log_written' },
      { kind: 'pre_post_state_delta_matches' },
      { kind: 'no_repo_mutation' },
      { kind: 'active_items_preserved' },
    ] },
    result: {
      restart_evidence: {
        pid_changed: true,
        health_check: { ok: true, status: 200 },
        expected_commit: 'abc',
        running_commit: 'abc',
        runtime_commit_matches: true,
      },
      admin_evidence: {
        pre_state_snapshot: { queued: 3 },
        post_state_snapshot: { queued: 1 },
        state_delta: { queued: -2 },
        audit_log_written: true,
        exit_code: 0,
      },
      diagnostic_evidence: { repo_mutated: false },
      cleanup_evidence: { active_items_preserved: true, audit_log_written: true },
    },
    runtimeContext: { listeningPorts: [8080] },
    config: { repoStatusPorcelain: '' },
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('no_mutation ignores GPTWork metadata artifacts', async (t) => {
  const { repoPath } = await makeRepo(t);
  await mkdir(join(repoPath, '.gptwork', 'goals', 'goal_1'), { recursive: true });
  await writeFile(join(repoPath, '.gptwork', 'goals', 'goal_1', 'result.json'), '{"status":"completed"}\n', 'utf8');

  const result = await runStateAssertions({
    repoPath,
    contract: { state_assertions: [{ kind: 'no_mutation' }] },
    result: { no_mutation: true, repo_mutated: false },
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('repo dirty and report head mismatch produce failures', async (t) => {
  const { repoPath, head } = await makeRepo(t);
  const reportPath = join(repoPath, 'report.json');
  await writeFile(reportPath, JSON.stringify({ passed: true, repo: { head: 'old-head', dirty: false } }), 'utf8');

  const result = await runStateAssertions({
    repoPath,
    contract: { state_assertions: [{ kind: 'repo_clean' }, { kind: 'report_head_matches' }] },
    result: { verification: { report_path: reportPath } },
    config: { repoStatusPorcelain: ' M README.md', repoHead: head },
  });

  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.kind === 'repo_clean'));
  assert.ok(result.failures.some((failure) => failure.kind === 'report_head_matches'));
});
