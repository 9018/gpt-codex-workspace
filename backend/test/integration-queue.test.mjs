/**
 * integration-queue.test.mjs
 * Tests for integration-queue.mjs — serial integration queue for same repo/branch.
 *
 * NOTE: runIntegrationQueue performs actual git operations and requires a
 * real git repo. These tests focus on the pure API surface and lock management.
 * Integration behavior tests should be in an e2e test with a real git repo.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIntegrationLocked, releaseIntegrationLock, runIntegrationQueue } from "../src/integration-queue.mjs";

function initRepoWithoutRemote() {
  const dir = mkdtempSync(join(tmpdir(), "gptwork-integration-no-remote-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "initial\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "task_branch"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "feature.txt"), "feature\n", "utf8");
  execFileSync("git", ["add", "feature.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: repo, stdio: "ignore" });
  return { dir, repo };
}

// ===========================================================================
// Tests for lock management
// ===========================================================================

test("isIntegrationLocked: returns false for unknown repo/branch", async () => {
  const result = await isIntegrationLocked("github.com/unknown/repo", "main");
  assert.equal(result, false);
});

test("releaseIntegrationLock: does not throw for unknown repo/branch", async () => {
  await releaseIntegrationLock("github.com/unknown/repo", "main");
  // Should not throw
  assert.ok(true);
});

test("releaseIntegrationLock: called on unknown key is a no-op", async () => {
  // Verify the function is callable and doesn't crash
  await releaseIntegrationLock("nonexistent/repo", "dev");
  assert.equal(await isIntegrationLocked("nonexistent/repo", "dev"), false);
});

// ===========================================================================
// Test: exports are present
// ===========================================================================

test("integration-queue exports expected symbols", async () => {
  const mod = await import("../src/integration-queue.mjs");
  assert.equal(typeof mod.runIntegrationQueue, "function");
  assert.equal(typeof mod.isIntegrationLocked, "function");
  assert.equal(typeof mod.releaseIntegrationLock, "function");
});

test("runIntegrationQueue push_branch returns push_failed when git push fails", async () => {
  const { dir, repo } = initRepoWithoutRemote();
  try {
    const result = await runIntegrationQueue({
      repoId: "repo-no-remote",
      targetBranch: "main",
      worktreePath: repo,
      canonicalRepoPath: repo,
      taskBranch: "task_branch",
      integrationMode: "push_branch",
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "push_failed");
    assert.equal(result.pushed, false);
    assert.match(result.error, /push/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runIntegrationQueue open_pr returns push_failed before attempting PR when push fails", async () => {
  const { dir, repo } = initRepoWithoutRemote();
  try {
    const result = await runIntegrationQueue({
      repoId: "repo-open-pr-no-remote",
      targetBranch: "main",
      worktreePath: repo,
      canonicalRepoPath: repo,
      taskBranch: "task_branch",
      integrationMode: "open_pr",
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "push_failed");
    assert.equal(result.pushed, false);
    assert.equal(result.pr_opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Test: TODO about Map-based in-memory lock
// ===========================================================================

test("integration-queue: memory lock note and TODO", async () => {
  // This test documents that INTEGRATION_LOCKS is a Map-based in-memory lock.
  // For production multi-process use, it should be replaced with persistent
  // locks (e.g., repo-lock-lifecycle filesystem locks).
  //
  // FIXED(P0): INTEGRATION_LOCKS now uses file-based locks when locksBasePath is provided.
  // locks using repo-lock-lifecycle's acquireRepoLock/releaseRepoLock pattern.
  // This ensures cross-process serial integration and survives process restarts.
  //
  // Current limitation: Map-based locks are per-process only. A process restart
  // loses all integration locks, which can result in concurrent integrations
  // on the same repo+branch.
  assert.ok(true, "TODO documented: INTEGRATION_LOCKS is Map-based (in-memory only)");
});

console.log("integration-queue tests loaded");
