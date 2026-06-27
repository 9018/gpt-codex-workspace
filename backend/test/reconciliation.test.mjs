import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import { acquireRepoLock } from "../src/repo-lock.mjs";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function makeServer(root) {
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
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

/**
 * Create a task, set it to "running", and create its goal directory.
 * No run metadata is created, so reconcileStaleTasks treats it as stale
 * (the "no run metadata" branch, where shouldMark = true immediately).
 */
async function setupRunningTask(server, wsRoot) {
  const created = await callTool(server, "create_task", {
    title: "Reconciliation test task"
  });
  const taskId = created.task.id;
  const goalId = created.task.goal_id;

  // Put task in running state (the state reconcileStaleTasks inspects)
  await callTool(server, "update_task_status", {
    task_id: taskId,
    status: "running"
  });

  // Ensure goal directory exists for optional result.json
  const goalDir = join(wsRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });

  return { taskId, goalId, goalDir };
}

// ================================================================
// Phase A reconciliation tests — result.json recovery
// ================================================================

test("reconciliation: valid result.json recovers task, not codex_stalled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId, goalDir } = await setupRunningTask(server, wsRoot);

  // Write a valid result.json
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Demo task completed",
    changed_files: ["example.js"],
    tests: "all passed",
    commit: "abc123",
    remote_head: "def456",
    warnings: [],
    followups: []
  }, null, 2));

  // Run startup reconciliation
  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true, "reconciliation should succeed");

  // Check the result details for the recovered task
  const details = reconResult.details || [];
  const recoveredDetail = details.find(d => d.task_id === taskId);
  assert.ok(recoveredDetail, "reconciliation should have processed the task");
  assert.ok(recoveredDetail.new_status !== "waiting_for_review",
    "recovered task should not be waiting_for_review");

  // Fetch the task and verify its state
  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.status, "completed", `expected completed, got ${task.status}`);
  assert.ok(task.result, "task result should be set");
  assert.notEqual(task.result.kind, "codex_stalled",
    "result kind must not be codex_stalled");
  assert.ok(task.result.kind === "codex_executed",
    `expected codex_executed, got ${task.result.kind}`);
  assert.equal(task.result.recovered_from_result_json, true,
    "recovery flag should be set");
  assert.equal(task.result.summary, "Demo task completed",
    "summary from result.json should be propagated");

  // Verify the recovery log
  const recoveryLogs = (task.logs || []).filter(
    l => l.message.includes("recovered completed result from existing result.json")
  );
  assert.ok(recoveryLogs.length >= 1,
    "task logs should contain the recovery message");
});

test("reconciliation: no result.json preserves codex_stalled", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId } = await setupRunningTask(server, wsRoot);
  // DO NOT write result.json

  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.status, "waiting_for_review",
    `expected waiting_for_review, got ${task.status}`);
  assert.ok(task.result, "task result should be set");
  assert.equal(task.result.kind, "codex_stalled",
    `expected codex_stalled, got ${task.result.kind}`);
});

test("reconciliation: stale_running_released_lock does not remain running", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId } = await setupRunningTask(server, wsRoot);
  const lockDir = join(wsRoot, ".gptwork", "locks", "repos");
  await mkdir(lockDir, { recursive: true });
  writeFileSync(join(lockDir, `test-${taskId}.json`), JSON.stringify({
    task_id: taskId,
    status: "released",
    released_at: new Date(Date.now() - 60_000).toISOString(),
    stale_reason: "owner process not found",
  }, null, 2));

  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.notEqual(task.status, "running", "released-lock stale task must not remain running");
  assert.equal(task.status, "waiting_for_review");
  assert.equal(task.result.kind, "stale_running_released_lock");
  assert.match(task.result.reconciliation_message, /released lock/i);
});

test("reconciliation: malformed result.json produces result_json_parse_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId, goalDir } = await setupRunningTask(server, wsRoot);

  // Write malformed JSON
  await writeFile(join(goalDir, "result.json"), "not valid json {{{");

  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.status, "waiting_for_review",
    `expected waiting_for_review, got ${task.status}`);
  assert.ok(task.result, "task result should be set");
  assert.equal(task.result.kind, "result_json_parse_failed",
    `expected result_json_parse_failed, got ${task.result.kind}`);
});

test("reconciliation: valid recovery releases repo lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId, goalDir } = await setupRunningTask(server, wsRoot);

  // Write a valid result.json
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "lock release test",
    changed_files: [],
    tests: "",
    commit: "abc",
    remote_head: "def",
    warnings: [],
    followups: []
  }, null, 2));

  // Acquire a repo lock for this task
  const repoPath = join(wsRoot, "test-repo");
  await mkdir(join(wsRoot, "test-repo"), { recursive: true });
  await acquireRepoLock(wsRoot, repoPath, { taskId, repoId: "test-repo-for-rec" });

  // Verify lock is held before reconciliation
  const lockBefore = await callTool(server, "repo_lock_status");
  assert.ok(lockBefore.active_repo_locks >= 1,
    "a lock should be active before recovery");

  // Run reconciliation
  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  // Verify lock is released after recovery
  const lockAfter = await callTool(server, "repo_lock_status");
  assert.equal(lockAfter.active_repo_locks, 0,
    "lock should be released after recovery");
});

test("reconciliation: result.json with invalid contract fields triggers parse_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId, goalDir } = await setupRunningTask(server, wsRoot);

  // Write valid JSON but missing required "status" field
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    summary: "Missing status field",
    changed_files: []
  }));

  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.result.kind, "result_json_parse_failed",
    `expected result_json_parse_failed, got ${task.result.kind}`);
});

test("reconciliation: invalid status value triggers parse_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec-"));
  const wsRoot = join(root, "workspace");
  await mkdir(wsRoot, { recursive: true });
  const server = await makeServer(root);

  const { taskId, goalDir } = await setupRunningTask(server, wsRoot);

  // Valid JSON with invalid status
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "invalid_value_xyz",
    summary: "test"
  }));

  const reconResult = await server.reconcileStaleTasks();
  assert.equal(reconResult.ok, true);

  const { task } = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.result.kind, "result_json_parse_failed",
    `expected result_json_parse_failed, got ${task.result.kind}`);
});
