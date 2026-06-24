import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTaskRepository, resolveTaskRepositoryPlan, materializeTaskWorktree } from '../src/task-repo-resolution.mjs';

async function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'initial\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

test('resolveTaskRepositoryPlan returns a plan without creating worktree (no git mutation)', async () => {
  const plan = await resolveTaskRepositoryPlan({
    task: { id: 'task_plan', repo_id: 'github.com/acme/test' },
    goal: {},
    config: { defaultWorkspaceRoot: '/tmp/ws', defaultRepoPath: '/repos/target' },
    registry: {
      async load() {},
      get(repoId) {
        return { repo_id: repoId, canonical_path: '/repos/target', default_branch: 'main' };
      },
    },
  });

  assert.equal(plan.repo_id, 'github.com/acme/test');
  assert.equal(plan.canonical_repo_path, '/repos/target');
  assert.equal(plan.target_branch, 'main');
  assert.equal(plan.base_ref, 'main');
  assert.ok(plan.task_branch.startsWith('gptwork/'));
  assert.equal(plan.task_id, 'task_plan');
  assert.ok(plan.task_worktree_path.includes('task_plan'));
  assert.equal(plan.uses_default_fallback, false);
  assert.equal(plan.worktree_lifecycle, null); // not materialized yet
});

test('resolveTaskRepositoryPlan falls back to default repo', async () => {
  const plan = await resolveTaskRepositoryPlan({
    task: { id: 'task_default' },
    goal: {},
    config: { defaultWorkspaceRoot: '/tmp/ws', defaultRepoPath: '/repos/default' },
    registry: { async load() {}, getDefaultRepo: () => null },
  });

  assert.equal(plan.repo_id, 'default');
  assert.equal(plan.canonical_repo_path, '/repos/default');
  assert.equal(plan.uses_default_fallback, true);
});

test('resolveTaskRepository creates a real task worktree by default', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-repo-resolution-'));
  const canonical = join(workspaceRoot, 'target');
  await initGitRepo(canonical);
  const registry = {
    async load() {},
    get(repoId) {
      assert.equal(repoId, 'github.com/acme/target');
      return { repo_id: repoId, canonical_path: canonical, default_branch: 'HEAD' };
    },
  };

  const resolved = await resolveTaskRepository({
    task: { id: 'task_123', repo_id: 'github.com/acme/target' },
    goal: { repo_id: 'github.com/acme/other' },
    config: { defaultWorkspaceRoot: workspaceRoot, defaultRepoPath: '/repos/default' },
    registry,
  });

  assert.equal(resolved.repo_id, 'github.com/acme/target');
  assert.equal(resolved.canonical_repo_path, canonical);
  assert.ok(resolved.lock_repo_path);
  assert.equal(resolved.uses_default_fallback, false);
  assert.equal(resolved.worktree_lifecycle.mode, 'git_worktree');
  assert.equal(resolved.worktree_lifecycle.ok, true);
  assert.equal(resolved.worktree_lifecycle.dirty_source, false);
  assert.deepEqual(resolved.worktree_lifecycle.dirty_paths, []);
  assert.ok(resolved.worktree_lifecycle.created_at);
  assert.equal(resolved.worktree_lifecycle.cleanup_policy, 'remove_on_success_retain_on_failure');
  assert.equal(resolved.worktree_lifecycle.lifecycle_events.length, 1);
  assert.equal(resolved.worktree_lifecycle.lifecycle_events[0].event, 'git_worktree_add');
  assert.equal(resolved.worktree_lifecycle.lifecycle_events[0].ok, true);
  assert.equal(resolved.task_worktree_path, join(workspaceRoot, 'worktrees/github.com-acme-target/task_123'));
});

test('resolveTaskRepository respects enableTaskWorktrees: false', async () => {
  const workspaceRoot = '/tmp/gptwork-ws';
  const canonical = '/repos/target';
  const registry = {
    async load() {},
    get(repoId) {
      return { repo_id: repoId, canonical_path: canonical };
    },
  };

  const resolved = await resolveTaskRepository({
    task: { id: 'task_legacy', repo_id: 'github.com/acme/target' },
    goal: {},
    config: { defaultWorkspaceRoot: workspaceRoot, defaultRepoPath: '/repos/default', enableTaskWorktrees: false },
    registry,
  });

  assert.equal(resolved.worktree_lifecycle, null);
  assert.equal(resolved.canonical_repo_path, canonical);
});

test('materializeTaskWorktree creates worktree from plan', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'gptwork-materialize-'));
  const canonical = join(workspaceRoot, 'target');
  await initGitRepo(canonical);

  const plan = await resolveTaskRepositoryPlan({
    task: { id: 'task_mat', repo_id: 'github.com/acme/materialize' },
    goal: {},
    config: { defaultWorkspaceRoot: workspaceRoot, defaultRepoPath: canonical },
    registry: {
      async load() {},
      get(repoId) {
        return { repo_id: repoId, canonical_path: canonical, default_branch: 'main' };
      },
    },
  });

  const materialized = await materializeTaskWorktree(plan, { config: { defaultWorkspaceRoot: workspaceRoot } });

  assert.ok(materialized.lock_repo_path);
  assert.equal(materialized.worktree_lifecycle.mode, 'git_worktree');
  assert.equal(materialized.worktree_lifecycle.ok, true);
  assert.equal(materialized.worktree_lifecycle.source_root, canonical);
  assert.ok(materialized.worktree_lifecycle.base_sha);
  assert.equal(materialized.worktree_lifecycle.branch_name, plan.task_branch);
  assert.equal(materialized.worktree_lifecycle.dirty_source, false);
  assert.deepEqual(materialized.worktree_lifecycle.dirty_paths, []);
  assert.ok(materialized.worktree_lifecycle.created_at);
  assert.equal(materialized.worktree_lifecycle.cleanup_policy, 'remove_on_success_retain_on_failure');
});
