#!/usr/bin/env node
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-tui-first-loop-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'e2e@example.com']);
  await git(root, ['config', 'user.name', 'GPTWork E2E']);
  await writeFile(join(root, 'README.md'), '# demo\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);

  const goalId = 'goal_e2e_demo';
  const branch = `gptwork/goal/${goalId}`;
  const worktree = join(root, '.gptwork', 'worktrees', goalId);
  await git(root, ['worktree', 'add', '-b', branch, worktree, 'main']);

  const goalDir = join(worktree, '.gptwork', 'goals', goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(worktree, 'feature.txt'), 'implemented\n');
  await writeFile(join(goalDir, 'result.md'), 'summary: implemented\n');
  await writeFile(join(goalDir, 'result.json'), JSON.stringify({ tests: [{ command: 'npm run check-syntax', exit_code: 0, summary: 'passed' }] }, null, 2));
  await git(worktree, ['add', '.']);
  await git(worktree, ['commit', '-m', 'feat: e2e candidate']);
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  await writeFile(join(goalDir, 'evidence.bundle.json'), JSON.stringify({
    goal_id: goalId,
    base_branch: 'main',
    base_sha: await git(root, ['rev-parse', 'main']),
    candidate_branch: branch,
    candidate_head: head,
    worktree_path: worktree,
    worktree_clean: true,
    changed_files: ['feature.txt'],
    commits: [{ sha: head, subject: 'feat: e2e candidate' }],
    result_md_present: true,
    result_json_present: true,
    tests: [{ command: 'npm run check-syntax', exit_code: 0, summary: 'passed' }],
    merge_base: await git(worktree, ['merge-base', 'main', 'HEAD']),
    diff_stat: 'feature.txt | 1 +',
    generated_at: new Date().toISOString()
  }, null, 2));
  await writeFile(join(goalDir, 'acceptance.result.json'), JSON.stringify({
    goal_id: goalId,
    stage: 'accept',
    provider: 'codex_tui_goal',
    verdict: 'passed',
    confidence: 'high',
    blocking_findings: [],
    non_blocking_findings: [],
    required_changes: [],
    merge_recommendation: 'merge',
    reviewed_candidate_head: head,
    created_at: new Date().toISOString()
  }, null, 2));

  await git(root, ['checkout', 'main']);
  await git(root, ['merge', '--no-ff', branch, '-m', `merge: ${goalId}`]);
  const mergeCommit = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(goalDir, 'merge.result.json'), JSON.stringify({ merged: true, merge_commit: mergeCommit }, null, 2));
  await writeFile(join(goalDir, 'advance.result.json'), JSON.stringify({
    goal_id: goalId,
    provider: 'claude_exec_goal',
    decision: 'stop',
    reason: 'e2e complete',
    next_goal: null,
    question: null,
    created_at: new Date().toISOString()
  }, null, 2));

  console.log(JSON.stringify({ ok: true, root, goalId, branch, mergeCommit }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
