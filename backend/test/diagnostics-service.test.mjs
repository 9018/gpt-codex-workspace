import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { determineBarkConfigSource, collectRestartMarkerStatus, resolveRepoDir, collectRuntimeGitInfo } from "../src/diagnostics-service.mjs";
import { writePendingRestartMarker } from "../src/safe-restart.mjs";

// ============================================================================
// determineBarkConfigSource tests
// ============================================================================

test("determineBarkConfigSource returns disabled when no keys match", () => {
  assert.equal(determineBarkConfigSource([]), "disabled");
  assert.equal(determineBarkConfigSource(["GPTWORK_WORKSPACE_ROOT", "GPTWORK_STATE_PATH"]), "disabled");
});

test("determineBarkConfigSource returns workspace-runtime-env when bark keys present in loaded keys", () => {
  assert.equal(determineBarkConfigSource(["GPTWORK_BARK_ENABLED"]), "workspace-runtime-env");
  assert.equal(determineBarkConfigSource(["GPTWORK_BARK_URL", "GPTWORK_BARK_KEY"]), "workspace-runtime-env");
  assert.equal(determineBarkConfigSource(["GPTWORK_BARK_GROUP", "GPTWORK_WORKSPACE_ROOT"]), "workspace-runtime-env");
});

test("determineBarkConfigSource returns process.env when bark vars set in env but not in loaded keys", () => {
  // Set a bark env var temporarily to test process.env detection
  const prev = process.env.GPTWORK_BARK_SOUND;
  process.env.GPTWORK_BARK_SOUND = "bell";
  try {
    assert.equal(determineBarkConfigSource([]), "process.env");
    assert.equal(determineBarkConfigSource(["GPTWORK_WORKSPACE_ROOT"]), "process.env");
  } finally {
    if (prev !== undefined) {
      process.env.GPTWORK_BARK_SOUND = prev;
    } else {
      delete process.env.GPTWORK_BARK_SOUND;
    }
  }
});

test("determineBarkConfigSource treats all known bark var names", () => {
  const expectedVars = ["GPTWORK_BARK_ENABLED", "GPTWORK_BARK_URL", "GPTWORK_BARK_KEY", "GPTWORK_BARK_GROUP", "GPTWORK_BARK_SOUND", "GPTWORK_BARK_LEVEL"];
  for (const v of expectedVars) {
    assert.equal(determineBarkConfigSource([v]), "workspace-runtime-env", `${v} should be recognized as bark config var`);
  }
});

// ============================================================================
// collectRestartMarkerStatus tests
// ============================================================================

test("collectRestartMarkerStatus returns empty counts for non-existent dir", async () => {
  const result = await collectRestartMarkerStatus("/nonexistent/workspace");
  assert.equal(result.total_count, 0);
  assert.equal(result.active_count, 0);
  assert.equal(result.marker_dir_exists, false);
  assert.equal(result.statuses.pending, 0);
  assert.equal(result.statuses.scheduled, 0);
  assert.equal(result.statuses.restarted, 0);
  assert.equal(result.statuses.verified, 0);
  assert.equal(result.statuses.failed, 0);
});

test("collectRestartMarkerStatus counts markers correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-ds-restart-"));
  const workspaceRoot = join(root, "workspace");

  // Create markers with different statuses
  await writePendingRestartMarker(workspaceRoot, "task-1", {
    requested_by: "test",
    expected_commit: "abc123",
    expected_remote_head: "def456",
  });
  await writePendingRestartMarker(workspaceRoot, "task-2", {
    requested_by: "test",
    expected_commit: "abc456",
    expected_remote_head: "def789",
  });
  await writePendingRestartMarker(workspaceRoot, "task-3", {
    requested_by: "test",
    expected_commit: "abc789",
    expected_remote_head: "def012",
  });

  // Override statuses via marker files (direct file manipulation)
  const { updateRestartMarkerStatus } = await import("../src/safe-restart.mjs");
  await updateRestartMarkerStatus(workspaceRoot, "task-1", "verified");
  await updateRestartMarkerStatus(workspaceRoot, "task-2", "failed");
  // task-3 stays as "pending"

  const result = await collectRestartMarkerStatus(workspaceRoot);
  assert.equal(result.total_count, 3);
  assert.equal(result.active_count, 1); // only task-3 is pending (active)
  assert.equal(result.statuses.pending, 1);
  assert.equal(result.statuses.verified, 1);
  assert.equal(result.statuses.failed, 1);
  assert.equal(result.statuses.scheduled, 0);
  assert.equal(result.statuses.restarted, 0);
  assert.ok(result.marker_dir_exists);
});

// ============================================================================
// resolveRepoDir tests (basic checks)
// ============================================================================

test("resolveRepoDir returns null when not in a git repo dir", () => {
  const result = resolveRepoDir();
  // When called from the test dir (which is likely inside a git repo),
  // this may return a path. If called from a non-git dir, returns null.
  // At minimum ensure it returns either null or a string.
  assert.ok(result === null || typeof result === "string");
});

// ============================================================================
// collectRuntimeGitInfo tests (basic checks)
// ============================================================================

test("collectRuntimeGitInfo returns object with expected shape when repoDir is null", () => {
  const result = collectRuntimeGitInfo(null);
  assert.equal(typeof result.repo_head, "object");
  assert.equal(result.repo_head, null);
  assert.equal(result.remote_head, null);
  assert.equal(result.running_commit, null);
  assert.equal(result.worktree_dirty, false);
  assert.deepEqual(result.dirty_paths, []);
});

test("collectRuntimeGitInfo returns object with expected keys when repoDir is valid", () => {
  // This test will succeed if a git repo is found; otherwise it checks shape
  const repoDir = resolveRepoDir();
  const result = collectRuntimeGitInfo(repoDir);
  assert.ok("repo_head" in result);
  assert.ok("remote_head" in result);
  assert.ok("running_commit" in result);
  assert.ok("worktree_dirty" in result);
  assert.ok("dirty_paths" in result);
  assert.ok(Array.isArray(result.dirty_paths));
});
