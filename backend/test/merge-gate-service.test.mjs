import './helpers/env-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { previewMergeGate } from '../src/merge-gate-service.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('previewMergeGate writes structured conflict evidence and repair proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merge-gate-conflict-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'checkout', '-b', 'candidate');
  await writeFile(join(repo, 'shared.txt'), 'candidate\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'candidate');
  const candidateHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'main');
  await writeFile(join(repo, 'shared.txt'), 'main\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'main change');

  const goalId = 'goal_conflict';
  const goalDir = join(repo, '.gptwork', 'goals', goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, 'evidence.bundle.json'), JSON.stringify({
    candidate_head: candidateHead, worktree_clean: true,
    result_md_present: true, result_json_present: true
  }));
  await writeFile(join(goalDir, 'acceptance.result.json'), JSON.stringify({
    verdict: 'passed', merge_recommendation: 'merge', reviewed_candidate_head: candidateHead
  }));

  const result = await previewMergeGate({
    goalId,
    workspace: { worktree_path: repo, candidate_branch: 'candidate', merge_target: 'main' },
    config: { defaultRepoPath: repo }
  });
  assert.equal(result.decision, 'conflict');
  assert.equal(result.repair_proposal?.kind, 'merge_conflict_repair');
  assert.ok(result.conflict_evidence?.files.includes('shared.txt'));
  const persisted = JSON.parse(await readFile(join(goalDir, 'merge.decision.json'), 'utf8'));
  assert.deepEqual(persisted.conflict_evidence.files, ['shared.txt']);
  await rm(root, { recursive: true, force: true });
});
