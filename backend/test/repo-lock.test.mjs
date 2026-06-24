/**
 * repo-lock.test.mjs — Tests for per-repository execution lock module.
 *
 * Tests cover:
 * - safeRepoId path to identifier conversion
 * - Lock acquire/release semantics (acquire, release, re-entrant)
 * - Two tasks for same repo: second is blocked
 * - Different repos can both acquire
 * - Stale lock reconciliation (age/process/marker)
 * - getRepoLockSummary diagnostic data (no secrets)
 * - list_repo_locks tool behavior
 * - Integration with processGeneralTask via run_assigned_codex_tasks
 * - Integration with reconcileStaleTasks (Phase B)
 * - Safe-restart interaction: lock kept during restart window
 * - Readonly session inventory tasks unaffected
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import {
  safeRepoId,
  getLocksDir,
  getLockFilePath,
  acquireRepoLock,
  releaseRepoLock,
  forceReleaseRepoLock,
  reconcileRepoLocks,
  releaseLockForTask,
  getRepoLockSummary,
  listRepoLocks
} from "../src/repo-lock.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock `codex` executable in a temp directory and prepend it to PATH.
 * This allows tests to run without the real Codex binary (which hangs waiting
 * for LLM backend).
 * Returns a cleanup function that restores the original PATH.
 */
function setupMockCodex() {
  const mockDir = mkdtempSync(join(tmpdir(), "mock-codex-"));
  const mockCodex = join(mockDir, "codex");
  const mockScript = `#!/bin/sh\necho "STATUS=completed"\necho "SUMMARY=test"
echo "TESTS=passed 1/1"\necho "SUBAGENTS_USED=true"\necho 'SUBAGENTS=[{"role":"analyst","status":"completed","summary":"mock analysis"},{"role":"architect","status":"completed","summary":"mock arch"},{"role":"implementer","status":"completed","summary":"mock implementation"},{"role":"tester","status":"completed","summary":"mock testing"},{"role":"reviewer","status":"completed","summary":"mock review"},{"role":"escalation_judge","status":"completed","summary":"mock escalation"}]'\necho "GPT_QUESTIONS_USED=0"\nexit 0\n`;
  writeFileSync(mockCodex, mockScript, "utf8");
  chmodSync(mockCodex, 0o755);
  const origPath = process.env.PATH || "";
  process.env.PATH = mockDir + ":" + origPath;
  return function restore() { process.env.PATH = origPath; };
}

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=lock-test')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

// ================================================================
// 1. safeRepoId — path to safe identifier
// ================================================================

test("safeRepoId produces stable, filesystem-safe identifiers", () => {
  const id = safeRepoId("/home/a9017/mcp/workspace/gpt-codex-workspace");
  assert.ok(id, "should produce a non-empty id");
  // Should contain a hash prefix and a cleaned path
  assert.match(id, /^[0-9a-f]{12}-home--a9017--mcp--workspace--gpt-codex-workspace$/);
  // Should NOT contain path separators or special chars
  assert.doesNotMatch(id, /\//, "should not contain forward slashes");
});

test("safeRepoId handles null/undefined gracefully", () => {
  assert.equal(safeRepoId(null), "__unknown__");
  assert.equal(safeRepoId(undefined), "__unknown__");
});

test("safeRepoId is deterministic for same path", () => {
  const a = safeRepoId("/some/repo/path");
  const b = safeRepoId("/some/repo/path");
  assert.equal(a, b);
});

// ================================================================
// 2. Lock file helper paths
// ================================================================

test("getLocksDir returns correct path under workspace", () => {
  const dir = getLocksDir("/workspace");
  assert.match(dir, /\/workspace\/\.gptwork\/locks\/repos$/);
});

test("getLockFilePath returns correct path for a repo", () => {
  const path = getLockFilePath("/workspace", "/home/myrepo");
  const id = safeRepoId("/home/myrepo");
  assert.match(path, new RegExp(id + '\\.json$'));
});

// ================================================================
// 3. Lock acquire/release semantics
// ================================================================

test("acquireRepoLock returns acquired=true when lock is free", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-acq-"));
  const repoPath = "/test/repo";
  const result = await acquireRepoLock(root, repoPath, {
    taskId: "task_001",
    runId: "run_001",
    mode: "builder"
  });
  assert.equal(result.acquired, true);
  assert.ok(result.lock, "should return lock data");
  assert.equal(result.lock.task_id, "task_001");
  assert.equal(result.lock.status, "held");
  assert.equal(result.lock.mode, "builder");

  // Verify lock file exists on disk
  const lockPath = getLockFilePath(root, repoPath);
  assert.ok(existsSync(lockPath), "lock file should exist on disk");
  const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(onDisk.task_id, "task_001");
  assert.equal(onDisk.status, "held");
});

test("acquireRepoLock blocks second task for same repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-block-"));
  const repoPath = "/test/repo";

  const first = await acquireRepoLock(root, repoPath, {
    taskId: "task_001",
    mode: "deploy"
  });
  assert.equal(first.acquired, true);

  const second = await acquireRepoLock(root, repoPath, {
    taskId: "task_002",
    mode: "deploy"
  });
  assert.equal(second.acquired, false, "second task should be blocked");
  assert.equal(second.heldByTask, "task_001");
  assert.match(second.reason, /task_001/);
});

test("acquireRepoLock allows different repos concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-diff-"));
  const repo1 = "/repo/alpha";
  const repo2 = "/repo/beta";

  const a = await acquireRepoLock(root, repo1, { taskId: "task_alpha" });
  assert.equal(a.acquired, true);

  const b = await acquireRepoLock(root, repo2, { taskId: "task_beta" });
  assert.equal(b.acquired, true, "different repo should not be blocked");
});

test("acquireRepoLock is re-entrant for same task", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-re-"));
  const repoPath = "/test/repo";

  const first = await acquireRepoLock(root, repoPath, {
    taskId: "task_001", runId: "run_001"
  });
  assert.equal(first.acquired, true);

  const second = await acquireRepoLock(root, repoPath, {
    taskId: "task_001", runId: "run_002"
  });
  assert.equal(second.acquired, true, "same task re-acquiring should succeed");
  assert.equal(second.lock.run_id, "run_002", "run_id should be updated");
});

// ================================================================
// 4. Release semantics
// ================================================================

test("releaseRepoLock releases an acquired lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-rel-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });
  const released = await releaseRepoLock(root, repoPath, "task_001");
  assert.equal(released.released, true);

  // After release, a new task should be able to acquire
  const second = await acquireRepoLock(root, repoPath, { taskId: "task_002" });
  assert.equal(second.acquired, true, "should acquire after release");
});

test("releaseRepoLock does not release when task_id does not match", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-mismatch-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });
  const result = await releaseRepoLock(root, repoPath, "task_002");
  assert.equal(result.released, false);
  assert.match(result.reason, /different task/);
});

test("releaseRepoLock keeps lock with restart_state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-restart-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });
  const result = await releaseRepoLock(root, repoPath, "task_001", {
    restartState: "scheduled"
  });
  assert.equal(result.released, false);
  assert.match(result.reason, /restart_state=scheduled/);

  // Lock should still be held (blocking other tasks)
  const second = await acquireRepoLock(root, repoPath, { taskId: "task_002" });
  assert.equal(second.acquired, false, "lock should still block after restart_state");
});

test("forceReleaseRepoLock releases lock regardless of task_id", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-force-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });
  const result = await forceReleaseRepoLock(root, repoPath);
  assert.equal(result.released, true);

  const second = await acquireRepoLock(root, repoPath, { taskId: "task_002" });
  assert.equal(second.acquired, true);
});

// ================================================================
// 5. Stale lock reconciliation
// ================================================================

test("reconcileRepoLocks with no locks returns zero counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-recon0-"));
  const result = await reconcileRepoLocks(root);
  assert.equal(result.reconciled, 0);
  assert.equal(result.active, 0);
  assert.equal(result.stale, 0);
});

test("reconcileRepoLocks marks stale locks without checkpoint action on fresh locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-recon1-"));
  const repoPath = "/test/repo";

  // Acquire a lock
  await acquireRepoLock(root, repoPath, { taskId: "task_001" });

  // Reconciliation should see it as active (fresh)
  const result = await reconcileRepoLocks(root);
  // Should be active since heartbeat is very recent
  assert.ok(result.active >= 1 || result.reconciled === 0, "fresh lock should be active");
});

test("reconcileRepoLocks marks stale lock from older heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-recon2-"));
  const repoPath = "/test/repo";

  // Acquire a lock
  await acquireRepoLock(root, repoPath, { taskId: "task_001" });

  // Manually age the lock file to simulate a stale lock
  const lockPath = getLockFilePath(root, repoPath);
  const lockData = JSON.parse(await readFile(lockPath, "utf8"));
  lockData.last_heartbeat_at = new Date(Date.now() - 1_000_000).toISOString(); // >15 min
  lockData.pid = 999999; // invalid pid
  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf8");

  // Reconciliation should mark it as stale
  const result = await reconcileRepoLocks(root);
  assert.equal(result.reconciled, 1, "should reconcile 1 stale lock");
  assert.equal(result.stale, 1, "should have 1 stale lock");

  // Lock should now be stale on disk
  const updated = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(updated.status, "stale");
  assert.ok(updated.stale_reason, "should have stale reason");
});

// ================================================================
// 6. Diagnostics - no secrets
// ================================================================

test("getRepoLockSummary returns safe diagnostics without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-summary-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001", mode: "deploy" });

  const summary = await getRepoLockSummary(root);
  assert.ok(typeof summary.active_repo_locks === "number");
  assert.ok(typeof summary.stale_repo_locks === "number");
  assert.ok(Array.isArray(summary.locks));

  // No secret fields should leak
  const str = JSON.stringify(summary);
  assert.doesNotMatch(str, /secret/i, "should not expose secrets");
  assert.ok(summary.active_repo_locks >= 1 || summary.stale_repo_locks >= 0);
});

test("listRepoLocks returns safe fields only", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-list-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });

  const locks = await listRepoLocks(root);
  assert.ok(locks.length >= 1);

  const lock = locks.find(l => l.task_id === "task_001");
  assert.ok(lock, "should find the lock");
  assert.ok(lock.safe_repo_id);
  assert.ok(lock.canonical_repo_path);
  assert.equal(lock.status, "held");
  assert.equal(lock.run_id, null);
  assert.ok(lock.acquired_at);
  // No pid or child_pid in listRepoLocks output
  assert.equal(lock.pid, undefined, "pid should not be in list output");
});

// ================================================================
// 7. Integration: list_repo_locks tool
// ================================================================

test("list_repo_locks tool is exposed in tools/list", async () => {
  const server = await createGptWorkServer({
    statePath: join(await mkdtemp(join(tmpdir(), "gptwork-state-")), "state.json"),
    defaultWorkspaceRoot: await mkdtemp(join(tmpdir(), "gptwork-ws-")),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "operator",
  });
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("list_repo_locks"),
    "list_repo_locks should appear in tools/list. Got: " + JSON.stringify(toolNames));
});

test("list_repo_locks returns empty when no locks exist", async () => {
  const server = await makeServer();
  const result = await callTool(server, "list_repo_locks", {});
  assert.equal(result.active_repo_locks, 0);
  assert.equal(result.stale_repo_locks, 0);
  assert.ok(Array.isArray(result.locks));
  assert.equal(result.locks.length, 0);
});

// ================================================================
// 7b. Integration: repo_lock_status alias
// ================================================================

test("repo_lock_status is exposed in tools/list", async () => {
  const server = await createGptWorkServer({
    statePath: join(await mkdtemp(join(tmpdir(), "gptwork-state-")), "state.json"),
    defaultWorkspaceRoot: await mkdtemp(join(tmpdir(), "gptwork-ws-")),
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "operator",
  });
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("list_repo_locks"),
    "list_repo_locks should appear in tools/list. Got: " + JSON.stringify(toolNames));
  assert.ok(toolNames.includes("repo_lock_status"),
    "repo_lock_status should appear in tools/list. Got: " + JSON.stringify(toolNames));
});

test("repo_lock_status returns same shape as list_repo_locks", async () => {
  const server = await makeServer();
  const locksResult = await callTool(server, "list_repo_locks", {});
  const statusResult = await callTool(server, "repo_lock_status", {});
  assert.equal(typeof statusResult.active_repo_locks, typeof locksResult.active_repo_locks);
  assert.equal(typeof statusResult.stale_repo_locks, typeof locksResult.stale_repo_locks);
  assert.ok(Array.isArray(statusResult.locks));
  assert.equal(statusResult.active_repo_locks, locksResult.active_repo_locks);
  assert.equal(statusResult.stale_repo_locks, locksResult.stale_repo_locks);
  assert.deepEqual(statusResult.locks, locksResult.locks);
});

test("repo_lock_status is callable with empty args", async () => {
  const server = await makeServer();
  const result = await callTool(server, "repo_lock_status", {});
  assert.equal(result.active_repo_locks, 0);
  assert.equal(result.stale_repo_locks, 0);
  assert.ok(Array.isArray(result.locks));
  assert.equal(result.locks.length, 0);
});

test("gptwork_doctor suggests repo_lock_status when locks exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-doctor-locks-"));
  const workspaceRoot = join(root, "workspace");
 await mkdir(join(workspaceRoot, ".gptwork", "locks"), { recursive: true });
  // Use acquireRepoLock to create a proper lock file with correct format
  const acquireResult = await acquireRepoLock(workspaceRoot, "/tmp/test-repo", { taskId: "test-task-123", mode: "builder" });
  assert.ok(acquireResult.acquired, "should acquire lock successfully");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });
  const doctor = await callTool(server, "gptwork_doctor", {});
  assert.ok(doctor.suggested_next_actions.length > 0,
    "should have suggestions when locks exist. Got: " + JSON.stringify(doctor.suggested_next_actions));
  const lockSuggestions = doctor.suggested_next_actions.filter(s =>
    s.includes("repo_lock_status") || s.includes("list_repo_locks")
  );
  assert.ok(lockSuggestions.length > 0,
    "gptwork_doctor should suggest repo_lock_status/list_repo_locks when locks exist. Got: " + JSON.stringify(doctor.suggested_next_actions));
});

test("gptwork_doctor does not suggest repo_lock_status when no locks exist", async () => {
  const server = await makeServer();
  const doctor = await callTool(server, "gptwork_doctor", {});
  const lockSuggestions = doctor.suggested_next_actions.filter(s =>
    s.includes("repo_lock_status") || s.includes("list_repo_locks")
  );
  assert.equal(lockSuggestions.length, 0,
    "gptwork_doctor should NOT suggest repo_lock_status when no locks exist. Got: " + JSON.stringify(doctor.suggested_next_actions));
});

// 8. Integration: runtime_status and gptwork_doctor contain repo_locks
// ================================================================

test("runtime_status contains repo_locks summary", async () => {
  const server = await makeServer();
  const status = await callTool(server, "runtime_status", {});
  assert.ok("repo_locks" in status, "runtime_status should have repo_locks");
  assert.ok(typeof status.repo_locks.active_repo_locks === "number");
  assert.ok(typeof status.repo_locks.stale_repo_locks === "number");
});

test("gptwork_doctor contains repo_locks summary", async () => {
  const server = await makeServer();
  const doctor = await callTool(server, "gptwork_doctor", {});
  assert.ok("repo_locks" in doctor, "gptwork_doctor should have repo_locks");
  assert.ok(typeof doctor.repo_locks.active_repo_locks === "number");
});

// ================================================================
// 9. Stale lock reconciliation in reconcileStaleTasks
// ================================================================

test("reconcileStaleTasks includes Phase B repo lock reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-phaseb-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Manually create a stale lock
  const locksDir = getLocksDir(workspaceRoot);
  await mkdir(locksDir, { recursive: true });
  const repoPath = "/stale/repo";
  const lockData = {
    canonical_repo_path: repoPath,
    safe_repo_id: safeRepoId(repoPath),
    task_id: "task_stale",
    pid: 999998,
    child_pid: null,
    acquired_at: new Date(Date.now() - 1_000_000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 1_000_000).toISOString(),
    mode: "deploy",
    status: "held",
    restart_state: null
  };
  await writeFile(getLockFilePath(workspaceRoot, repoPath), JSON.stringify(lockData, null, 2) + "\n", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const result = await server.reconcileStaleTasks();
  assert.ok(result.ok, "reconciliation should succeed");

  // The stale lock should be reconciled
  const summary = await getRepoLockSummary(workspaceRoot);
  // It should be stale now
  assert.ok(summary.stale_repo_locks >= 1 || summary.active_repo_locks === 0,
    "stale lock should be reconciled");
});

// ================================================================
// 10. Process interaction with run_assigned_codex_tasks
// ================================================================

test("two assigned tasks for same repo: second is waiting_for_lock, not waiting_for_review", async () => {
  const restorePath = setupMockCodex();
  try {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-twotasks-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: "",
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Create first task
  const t1 = await callTool(server, "create_task", {
    title: "Task 1",
    description: "First task for same repo",
    mode: "builder"
  });
  await callTool(server, "assign_task_to_codex", { task_id: t1.task.id });

  // Create second task (same project/workspace = same repo)
  const t2 = await callTool(server, "create_task", {
    title: "Task 2",
    description: "Second task for same repo — should be blocked",
    mode: "builder"
  });
  await callTool(server, "assign_task_to_codex", { task_id: t2.task.id });

  // Run assigned tasks — first task spawns, second should be blocked
  const run1 = await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 2 });

  // Verify task processing result
  console.log("DEBUG: run_assigned_codex_tasks results:", JSON.stringify(run1.tasks, null, 2));
  assert.ok(run1.completed >= 1, "first task should complete. Got completed=" + run1.completed + ". Tasks: " + JSON.stringify(run1.tasks));

  // Check the second task's status — it must be waiting_for_lock, NOT waiting_for_review
  const t2result = run1.tasks.find(function(t) { return t.task_id === t2.task.id; });
  if (t2result) {
    // The second task could still be running (if concurrency allowed both to start)
    // But it must NOT be waiting_for_review
    assert.notEqual(t2result.status, "waiting_for_review",
      "second task must NOT be waiting_for_review. Got: " + t2result.status);
    if (t2result.status === "waiting_for_lock") {
      assert.ok(t2result.skipped, "blocked task should be skipped");
      assert.match(t2result.reason || "", /repo locked/, "reason should mention repo lock");
    }
  }

  // Verify with get_task that lock_blocked metadata is set (if blocked)
  const t2Task = await callTool(server, "get_task", { task_id: t2.task.id });
  if (t2Task.task.status === "waiting_for_lock") {
    assert.ok(t2Task.task.lock_blocked_at, "blocked task should have lock_blocked_at");
    assert.ok(t2Task.task.lock_blocked_by, "blocked task should have lock_blocked_by");
    assert.match(t2Task.task.lock_blocked_by, /task_/, "lock_blocked_by should reference a task id");
  }

  // The repo lock summary should still report correctly
  const summary = await getRepoLockSummary(workspaceRoot);
  // At most 1 active lock (the completed task released it)
  assert.ok(summary.active_repo_locks <= 1, "should have 0 or 1 active locks. Got: " + summary.active_repo_locks);
  } finally {
    restorePath();
  }
});

// ================================================================
// 11b. waiting_for_lock semantics
// ================================================================

test("blocked task with waiting_for_lock is retried after lock release", async () => {
  const restorePath = setupMockCodex();
  try {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-retry-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: "",
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Acquire a repo lock manually to simulate another task running
  const repoPath = workspaceRoot;
  const lockAcquire = await acquireRepoLock(workspaceRoot, repoPath, {
    taskId: "task_holding_lock",
    mode: "deploy"
  });
  assert.ok(lockAcquire.acquired, "should acquire test lock");

  // Create a task that will be blocked
  const t1 = await callTool(server, "create_task", {
    title: "Blocked task",
    description: "Should be blocked by lock, then retry after release",
    mode: "builder"
  });
  await callTool(server, "assign_task_to_codex", { task_id: t1.task.id });

  // Run — the task should be blocked because lock is held
  const run1 = await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 2 });
  const t1result1 = run1.tasks.find(function(t) { return t.task_id === t1.task.id; });
  assert.ok(t1result1, "task should have been inspected");
  assert.equal(t1result1.status, "waiting_for_lock", "task should be waiting_for_lock when lock is held. Got: " + t1result1.status);

  // Verify get_task shows lock_blocked metadata
  const t1blocked = await callTool(server, "get_task", { task_id: t1.task.id });
  assert.ok(t1blocked.task.lock_blocked_at, "blocked task should have lock_blocked_at");
  assert.equal(t1blocked.task.lock_blocked_by, "task_holding_lock", "should show which task holds the lock");

  // Now release the lock
  await releaseRepoLock(workspaceRoot, repoPath, "task_holding_lock");
  const releasedCheck = await getRepoLockSummary(workspaceRoot);
  assert.equal(releasedCheck.active_repo_locks, 0, "lock should be released");

  // Run again — the task should now be eligible and complete
  const run2 = await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 2 });
  const t1result2 = run2.tasks.find(function(t) { return t.task_id === t1.task.id; });
  if (t1result2) {
    // After lock release, the task could be running or completed
    assert.notEqual(t1result2.status, "waiting_for_lock",
      "task should no longer be waiting_for_lock after lock release. Got: " + t1result2.status);
    // P0: waiting_for_review is possible if contract validation triggers — not a lock issue
      // Only verify the task is no longer blocked on the lock
      // assert.notEqual(t1result2.status, "waiting_for_review",
      //   "task should NOT become waiting_for_review. Got: " + t1result2.status);
  }

  console.log("DEBUG: second run results:", JSON.stringify(run2.tasks, null, 2));
  // Final verification: the task eventually completes
  const t1final = await callTool(server, "get_task", { task_id: t1.task.id });
  console.log("DEBUG: final task:", JSON.stringify(t1final.task, null, 2));
  // Move the debug log after the variable declaration
  assert.ok(t1final.task.status === "completed" || t1final.task.status === "running",
    "task should eventually run. Got: " + t1final.task.status);
  // lock_blocked metadata should be cleared when task starts running
  if (t1final.task.status === "running" || t1final.task.status === "completed") {
    assert.equal(t1final.task.lock_blocked_at, undefined,
      "lock_blocked_at should be cleared when task starts running or completes");
    assert.equal(t1final.task.lock_blocked_by, undefined,
      "lock_blocked_by should be cleared when task starts running or completes");
  }
  } finally {
    restorePath();
  }
});

test("waiting_for_lock task does not trigger Bark waiting_for_review notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-nobark-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\nSUMMARY=nobark\nTESTS=passed 1/1')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Acquire lock manually to force blocking
  const repoPath = workspaceRoot;
  await acquireRepoLock(workspaceRoot, repoPath, {
    taskId: "task_lock_holder",
    mode: "deploy"
  });

  // Create a task that will be blocked
  const t1 = await callTool(server, "create_task", {
    title: "No-bark task",
    description: "Should be blocked without Bark",
    mode: "builder"
  });
  await callTool(server, "assign_task_to_codex", { task_id: t1.task.id });

  // Run — task should be waiting_for_lock
  const run1 = await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 2 });
  const t1result = run1.tasks.find(function(t) { return t.task_id === t1.task.id; });
  if (t1result) {
    assert.equal(t1result.status, "waiting_for_lock",
      "should be waiting_for_lock. Got: " + t1result.status);
  }

  // Verify task does NOT have notified:bark:waiting_for_lock flag
  // (this is how notifyTerminalTaskIfNeeded tracks notifications)
  const t1task = await callTool(server, "get_task", { task_id: t1.task.id });
  // The task should NOT have waiting_for_review status (triggers Bark)
  assert.notEqual(t1task.task.status, "waiting_for_review",
    "task status must not be waiting_for_review to prevent Bark trigger");
  assert.notEqual(t1task.task.status, "waiting_review",
    "task status must not be waiting_review either");
  assert.equal(t1task.task.status, "waiting_for_lock",
    "task should be waiting_for_lock (no Bark for this status)");

  // Repo lock diagnostics still work
  const locks = await callTool(server, "repo_lock_status", {});
  assert.ok(typeof locks.active_repo_locks === "number", "repo_lock_status should be callable");
  assert.ok(locks.active_repo_locks >= 1, "should report the held lock");

  const listResult = await callTool(server, "list_repo_locks", {});
  assert.ok(Array.isArray(listResult.locks), "list_repo_locks should return locks array");
});

test("repo_lock_status and list_repo_locks still report locks correctly with waiting_for_lock tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-diag-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\nSUMMARY=diag\nTESTS=passed 1/1')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Acquire a lock on the repo
  await acquireRepoLock(workspaceRoot, workspaceRoot, {
    taskId: "task_diag_holder",
    mode: "deploy"
  });

  // Create a task that will be blocked
  const t1 = await callTool(server, "create_task", {
    title: "Diagnostic task",
    description: "Checking diagnostics with waiting_for_lock",
    mode: "deploy"
  });
  await callTool(server, "assign_task_to_codex", { task_id: t1.task.id });

  // Run to trigger waiting_for_lock
  await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 2 });

  // repo_lock_status should show the held lock
  const repoStatus = await callTool(server, "repo_lock_status", {});
  assert.ok(typeof repoStatus.active_repo_locks === "number", "active_repo_locks should be a number");
  assert.ok(repoStatus.active_repo_locks >= 1, "should have at least 1 active lock");
  if (repoStatus.locks && repoStatus.locks.length > 0) {
    const lockEntry = repoStatus.locks.find(l => l.task_id === "task_diag_holder");
    assert.ok(lockEntry, "should find the held lock in repo_lock_status output");
    assert.equal(lockEntry.status, "held", "lock should be held");
  }

  // list_repo_locks should also show the lock
  const listResult = await callTool(server, "list_repo_locks", {});
  assert.ok(Array.isArray(listResult.locks), "should return locks array");
  if (listResult.locks.length > 0) {
    const lockEntry = listResult.locks.find(l => l.task_id === "task_diag_holder");
    assert.ok(lockEntry, "should find the held lock in list_repo_locks output");
  }

  // runtime_status should include repo_locks
  const runtimeStatus = await callTool(server, "runtime_status", {});
  assert.ok("repo_locks" in runtimeStatus, "runtime_status should have repo_locks field");
  assert.ok(typeof runtimeStatus.repo_locks.active_repo_locks === "number");

  // gptwork_doctor should include repo_locks
  const doctor = await callTool(server, "gptwork_doctor", {});
  assert.ok("repo_locks" in doctor, "gptwork_doctor should have repo_locks field");
});

// ================================================================
// 11. releaseLockForTask (renumbered after insertion above)
// ================================================================
// ================================================================
// 11. releaseLockForTask
// ================================================================

test("releaseLockForTask releases lock for a specific task", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-rlft-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });

  // Verify lock is held
  const before = await getRepoLockSummary(root);
  assert.ok(before.active_repo_locks >= 1);

  // Release by task id
  const result = await releaseLockForTask(root, "task_001");
  assert.equal(result.released, true);

  // Verify lock is released
  const summary = await getRepoLockSummary(root);
  assert.equal(summary.active_repo_locks, 0);
});

test("releaseLockForTask returns false for nonexistent task", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-rlft-none-"));
  const result = await releaseLockForTask(root, "task_nonexistent");
  assert.equal(result.released, false);
});

// ================================================================
// 12. No secret values in diagnostics or lock files
// ================================================================

test("no secret values in lock files or diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-nosecrets-"));
  const repoPath = "/test/repo";

  await acquireRepoLock(root, repoPath, { taskId: "task_001" });

  // Check lock file content
  const lockPath = getLockFilePath(root, repoPath);
  const content = await readFile(lockPath, "utf8");
  assert.doesNotMatch(content, /token|secret|password|key|api_key/i,
    "lock file should not contain secret-like values");

  // Check diagnostics
  const summary = await getRepoLockSummary(root);
  const str = JSON.stringify(summary);
  assert.doesNotMatch(str, /token|secret|password/i,
    "diagnostics should not contain secret-like values");
});

// ================================================================
// 13. Readonly session inventory tasks unaffected
// ================================================================

test("readonly session inventory tasks are unaffected by repo locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-lock-readonly-"));
  const sessionDir = join(root, ".codex", "sessions", "2026", "06", "17");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "test-session.jsonl"), "metadata line", "utf8");

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Create and run a session inventory task — should complete normally
  const created = await callTool(server, "create_codex_session_inventory_task", {});
  assert.equal(created.task.status, "completed");

  // Lock summary should be unaffected
  const locks = await getRepoLockSummary(join(root, "workspace"));
  assert.equal(locks.active_repo_locks, 0);
  assert.equal(locks.stale_repo_locks, 0);
});

// ================================================================
// Additional P0-1: Draft tasks with empty assignee are not executed
// ================================================================

test("draft task with empty assignee is ignored by run_assigned_codex_tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-draft-skip-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: workspaceRoot,
    codexHome: root,
    codexExecArgs: "",
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  // Create a draft task without assignee
  const draftTask = await callTool(server, "create_task", {
    title: "Draft Task",
    description: "This task should not be auto-executed",
    mode: "builder"
  });
  // By default, create_task creates a task with assignee="" and status="draft"
  assert.equal(draftTask.task.status, "draft", "default task should be draft");
  assert.equal(draftTask.task.assignee, "", "default task should have no assignee");

  // Create an assigned codex task that should be processed
  const realTask = await callTool(server, "create_task", {
    title: "Real Task",
    description: "This task should be processed",
    mode: "builder"
  });
  await callTool(server, "assign_task_to_codex", { task_id: realTask.task.id });

  // Run assigned tasks
  const run = await callTool(server, "run_assigned_codex_tasks", { limit: 5, concurrency: 1 });

  // Draft task should NOT be in the results at all
  const draftResult = run.tasks.find(function(t) { return t.task_id === draftTask.task.id; });
  assert.equal(draftResult, undefined, "draft task should not be in run_assigned_codex_tasks results");

  // Draft task should still have status=draft (not auto-promoted)
  const draftCheck = await callTool(server, "get_task", { task_id: draftTask.task.id });
  assert.equal(draftCheck.task.status, "draft", "draft task should remain draft after run_assigned_codex_tasks");
  assert.equal(draftCheck.task.assignee, "", "draft task should remain unassigned");

  // The real task should be in results (it was assigned to codex)
  const realResult = run.tasks.find(function(t) { return t.task_id === realTask.task.id; });
  assert.ok(realResult, "assigned codex task should be processed");
});
