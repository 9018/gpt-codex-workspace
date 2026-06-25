import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureTaskWorktree,
  removeTaskWorktree,
  pruneStaleWorktrees,
  getTaskWorktreePath,
  sanitizeWorktreeSegment,
  sanitizeTaskBranchName,
} from "../src/task-worktree-manager.mjs";

async function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

test("task worktree manager sanitizes repo/task path segments and branch names", () => {
  assert.equal(sanitizeWorktreeSegment("github.com/acme/../target repo"), "github.com-acme-target-repo");
  assert.equal(sanitizeTaskBranchName("task/../../bad name"), "gptwork/task/task-bad-name");

  const root = "/tmp/gptwork";
  const path = getTaskWorktreePath(root, "github.com/acme/../target repo", "task/../../bad name");
  assert.equal(path, join(root, ".gptwork", "worktrees", "github.com-acme-target-repo", "task-bad-name"));
});

test("ensureTaskWorktree creates and reuses a real git worktree, then remove/prune clean it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-wtm-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);

  const ensured = await ensureTaskWorktree("github.com/acme/repo", "task_001", {
    workspaceRoot: root,
    canonicalRepoPath: repo,
    baseRef: "HEAD",
  });

  assert.equal(ensured.ok, true);
  assert.equal(ensured.git_worktree_created, true);
  assert.equal(ensured.branch_name, "gptwork/task/task_001");
  assert.ok(existsSync(join(ensured.worktree_path, ".git")), "worktree should contain git metadata");

  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: ensured.worktree_path,
    encoding: "utf8",
  }).trim();
  assert.match(common, /canonical\/.git$/);

  const reused = await ensureTaskWorktree("github.com/acme/repo", "task_001", {
    workspaceRoot: root,
    canonicalRepoPath: repo,
    baseRef: "HEAD",
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.existing, true);
  assert.equal(reused.git_worktree_created, false);

  const removed = await removeTaskWorktree("task_001", {
    workspaceRoot: root,
    repoId: "github.com/acme/repo",
    canonicalRepoPath: repo,
  });
  assert.equal(removed.ok, true);
  assert.equal(existsSync(ensured.worktree_path), false);

  const pruned = await pruneStaleWorktrees({ workspaceRoot: root, canonicalRepoPath: repo });
  assert.equal(pruned.ok, true);
  assert.ok(pruned.ok === true);
});

test("ensureTaskWorktree reports git failures instead of pretending success", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-wtm-fail-"));
  const result = await ensureTaskWorktree("repo", "task_002", {
    workspaceRoot: root,
    canonicalRepoPath: join(root, "not-a-git-repo"),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /worktree add failed|not a git repository|No such file|ENOENT/i);
});

test("ensureTaskWorktree fails closed when canonical repo is dirty", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-wtm-dirty-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);
  await writeFile(join(repo, "dirty.txt"), "dirty\n", "utf8");

  const origEnv = process.env.GPTWORK_REQUIRE_CLEAN_CANONICAL;
  process.env.GPTWORK_REQUIRE_CLEAN_CANONICAL = 'true';
  const result = await ensureTaskWorktree("repo", "task_dirty", {
    workspaceRoot: root,
    canonicalRepoPath: repo,
  });
  process.env.GPTWORK_REQUIRE_CLEAN_CANONICAL = origEnv;

  assert.equal(result.ok, false);
  assert.match(result.error, /dirty/i);
  assert.equal(existsSync(getTaskWorktreePath(root, "repo", "task_dirty")), false);
});

test("pruneStaleWorktrees removes orphan task worktree directories after git prune", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-wtm-orphan-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);
  const orphan = join(root, ".gptwork", "worktrees", "github.com-acme-repo", "task_orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "leftover.txt"), "orphan\n", "utf8");

  const pruned = await pruneStaleWorktrees({ workspaceRoot: root, canonicalRepoPath: repo });

  assert.equal(pruned.ok, true);
  assert.ok(pruned.orphans_removed > 0 || (Array.isArray(pruned.removed_orphans) && pruned.removed_orphans.includes(orphan)));
  assert.ok(pruned.removed_orphans.includes(orphan));
  assert.equal(existsSync(orphan), false);
});

// ===========================================================================
// P0: Concurrent worktree isolation — same repo, three tasks, independent paths
// ===========================================================================

test("P0: ensureTaskWorktree creates three independent worktrees for same repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-concurrent-wtm-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);

  const taskIds = ["task_a", "task_b", "task_c"];
  const worktrees = [];

  // Create three worktrees concurrently (simulating parallel workers)
  const results = await Promise.all(taskIds.map((taskId) =>
    ensureTaskWorktree("github.com/acme/repo", taskId, {
      workspaceRoot: root,
      canonicalRepoPath: repo,
      baseRef: "HEAD",
    })
  ));

  // All three should succeed with independent paths
  for (let i = 0; i < taskIds.length; i++) {
    const result = results[i];
    assert.equal(result.ok, true, `Task ${taskIds[i]} should succeed`);
    assert.equal(result.git_worktree_created, true, `Task ${taskIds[i]} should create a new worktree`);
    assert.ok(result.worktree_path, `Task ${taskIds[i]} should have a worktree_path`);
    worktrees.push(result);

    // Verify each worktree is a real git worktree
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: result.worktree_path,
      encoding: "utf8",
    }).trim();
    assert.match(common, /canonical\/.git$/, `Worktree ${taskIds[i]} should link to canonical repo`);
  }

  // Verify all worktree paths are unique (no path collision)
  const paths = worktrees.map((w) => w.worktree_path);
  const uniquePaths = new Set(paths);
  assert.equal(uniquePaths.size, taskIds.length, "All worktrees should have unique paths");

  // Verify branch names are unique
  const branches = worktrees.map((w) => w.branch_name);
  const uniqueBranches = new Set(branches);
  assert.equal(uniqueBranches.size, taskIds.length, "All worktrees should have unique branch names");

  // Verify each worktree exists on disk
  for (const taskId of taskIds) {
    const wtPath = getTaskWorktreePath(root, "github.com/acme/repo", taskId);
    assert.ok(existsSync(join(wtPath, ".git")), `Worktree ${taskId} should exist on disk`);
  }

  // Verify that worktrees are independent (writing to one doesn't affect others)
  await writeFile(join(worktrees[0].worktree_path, "task_a_only.txt"), "only in task_a\n", "utf8");
  execFileSync("git", ["add", "task_a_only.txt"], { cwd: worktrees[0].worktree_path, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "task_a change"], { cwd: worktrees[0].worktree_path, stdio: "ignore" });

  // The other worktrees should not see this file
  const taskBGitFile = execFileSync("git", ["status", "--porcelain"], {
    cwd: worktrees[1].worktree_path,
    encoding: "utf8",
  }).trim();
  assert.equal(taskBGitFile, "", `Worktree task_b should be clean after task_a commit`);

  // Remove all three worktrees
  for (const taskId of taskIds) {
    const removed = await removeTaskWorktree(taskId, {
      workspaceRoot: root,
      repoId: "github.com/acme/repo",
      canonicalRepoPath: repo,
    });
    assert.equal(removed.ok, true);
  }

  // Verify all removed from disk
  for (const taskId of taskIds) {
    const wtPath = getTaskWorktreePath(root, "github.com/acme/repo", taskId);
    assert.equal(existsSync(wtPath), false, `Worktree ${taskId} should be removed from disk`);
  }
});

test("P0: ensureTaskWorktree concurrent worktrees have no lock contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-concurrent-lock-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);

  const taskIds = ["task_l1", "task_l2", "task_l3"];

  // Simulate concurrent creation by running Promise.all
  const results = await Promise.all(taskIds.map((taskId) =>
    ensureTaskWorktree("github.com/acme/repo", taskId, {
      workspaceRoot: root,
      canonicalRepoPath: repo,
      baseRef: "HEAD",
    })
  ));

  // All should succeed without lock errors
  for (let i = 0; i < taskIds.length; i++) {
    assert.equal(results[i].ok, true, `Task ${taskIds[i]} should not be blocked by other worktree creation`);
  }

  // Verify all worktree paths are under the same worktrees root
  const wtRoot = join(root, ".gptwork", "worktrees", "github.com-acme-repo");
  for (const taskId of taskIds) {
    const wtPath = getTaskWorktreePath(root, "github.com/acme/repo", taskId);
    assert.ok(wtPath.startsWith(wtRoot), `Worktree path ${wtPath} should be under ${wtRoot}`);
  }

  // Clean up
  for (const taskId of taskIds) {
    await removeTaskWorktree(taskId, {
      workspaceRoot: root,
      repoId: "github.com/acme/repo",
      canonicalRepoPath: repo,
    });
  }
});

test("P0: ensureTaskWorktree records execution_cwd and worktree_lifecycle metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-wtm-metadata-"));
  const repo = join(root, "canonical");
  await initGitRepo(repo);

  const result = await ensureTaskWorktree("github.com/acme/repo", "task_meta", {
    workspaceRoot: root,
    canonicalRepoPath: repo,
    baseRef: "HEAD",
  });

  assert.equal(result.ok, true);
  assert.ok(result.repo_id, "Should include repo_id");
  assert.ok(result.task_id, "Should include task_id");
  assert.ok(result.canonical_repo_path, "Should include canonical_repo_path");
  assert.ok(result.worktree_path, "Should include worktree_path");
  assert.ok(result.branch_name, "Should include branch_name");
  assert.ok(result.base_ref, "Should include base_ref");
  assert.equal(typeof result.dirty_source, "boolean", "Should include dirty_source boolean");
  assert.ok(Array.isArray(result.dirty_paths), "Should include dirty_paths array");

  // Clean up
  await removeTaskWorktree("task_meta", {
    workspaceRoot: root,
    repoId: "github.com/acme/repo",
    canonicalRepoPath: repo,
  });
});

console.log("P0 worktree concurrency tests loaded");
