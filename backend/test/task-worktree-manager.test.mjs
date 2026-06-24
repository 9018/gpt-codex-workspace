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
  assert.equal(sanitizeTaskBranchName("task/../../bad name"), "gptwork/task-bad-name");

  const root = "/tmp/gptwork";
  const path = getTaskWorktreePath(root, "github.com/acme/../target repo", "task/../../bad name");
  assert.equal(path, join(root, "worktrees", "github.com-acme-target-repo", "task-bad-name"));
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
  assert.equal(ensured.branch_name, "gptwork/task_001");
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
  const orphan = join(root, "worktrees", "github.com-acme-repo", "task_orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "leftover.txt"), "orphan\n", "utf8");

  const pruned = await pruneStaleWorktrees({ workspaceRoot: root, canonicalRepoPath: repo });

  assert.equal(pruned.ok, true);
  assert.ok(pruned.orphans_removed > 0 || (Array.isArray(pruned.removed_orphans) && pruned.removed_orphans.includes(orphan)));
  assert.ok(pruned.removed_orphans.includes(orphan));
  assert.equal(existsSync(orphan), false);
});
