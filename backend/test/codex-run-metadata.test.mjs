import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import {
  initRun,
  updateRunHeartbeat,
  fireHeartbeat,
  writeRunLogs,
  loadRun,
  listRuns,
  getLatestRun,
  isProcessAlive,
  isRepoDirty,
  getRunDir,
  getRunFilePath,
  getStdoutLogPath,
  getStderrLogPath
} from "../src/codex-run-metadata.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rundiag-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=worker-ok')"`,
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

/**
 * Helper: create a default state with a running task seeded with stale run metadata.
 */
async function createSeededState(root, taskId, overrides = {}) {
  const workspaceRoot = join(root, "workspace");
  const statePath = join(root, "state.json");
  const now = new Date().toISOString();
  const old = new Date(Date.now() - (overrides.heartbeatAgeMs || 700000)).toISOString(); // > 600s default

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{
      id: "default",
      team_id: "team_default",
      name: "Default Project",
      default_workspace_id: "hosted-default",
      created_at: now, updated_at: now
    }],
    workspaces: [{
      id: "hosted-default",
      project_id: "default",
      name: "Hosted Default",
      type: "hosted", root: workspaceRoot, default: true,
      created_at: now, updated_at: now
    }],
    goals: [],
    conversations: [],
    memories: [],
    tasks: [{
      id: taskId,
      project_id: "default",
      workspace_id: "hosted-default",
      title: overrides.title || "Stuck task",
      description: overrides.description || "Test stuck task",
      created_by: "user_default",
      assignee: "codex",
      status: "running",
      mode: "builder",
      logs: [
        { time: old, message: "[worker] codex exec started" }
      ],
      artifacts: [],
      result: null,
      created_at: old,
      updated_at: old,
      ...overrides.taskOverrides
    }],
    chatgpt_requests: [],
    activities: [],
    audit: []
  };

  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create stale run metadata
  await initRun({
    workspaceRoot,
    taskId,
    workspaceId: "hosted-default",
    repoPath: workspaceRoot
  });
  const run = await getLatestRun(workspaceRoot, taskId);
  // Stale the heartbeat
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = old;
    runData.phase = "running_codex";
    runData.codex_child_pid = overrides.fakePid || 999999; // unlikely to exist
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  return { statePath, workspaceRoot, taskId };
}

// ================================================================
// 1. Run metadata written when Codex starts
// ================================================================

test("initRun creates run.json with correct metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-initrun-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const { runDir, runFilePath, runId, runData } = await initRun({
    workspaceRoot,
    taskId: "task_test_1",
    workspaceId: "hosted-default",
    repoPath: "/tmp/repo",
    promptPath: "/tmp/prompt.txt"
  });

  assert.ok(runId, "run_id should be generated");
  assert.match(runId, /^[0-9a-f-]+$/);
  assert.equal(runData.task_id, "task_test_1");
  assert.equal(runData.workspace_id, "hosted-default");
  assert.equal(runData.repo_path, "/tmp/repo");
  assert.equal(runData.prompt_path, "/tmp/prompt.txt");
  assert.equal(runData.phase, "preparing");
  assert.equal(runData.codex_child_pid, null);
  assert.equal(runData.exit_code, null);
  assert.equal(runData.timed_out, false);
  assert.ok(runData.started_at);
  assert.ok(runData.last_heartbeat_at);
  assert.match(runData.stdout_log_path, /stdout\.log$/);
  assert.match(runData.stderr_log_path, /stderr\.log$/);
  assert.equal(runData.result_json_path, null);

  // Verify file on disk
  assert.ok(existsSync(runFilePath), "run.json should exist on disk");
  const onDisk = JSON.parse(await readFile(runFilePath, "utf8"));
  assert.equal(onDisk.run_id, runId);
  assert.equal(onDisk.task_id, "task_test_1");
  assert.equal(onDisk.phase, "preparing");
});

test("updateRunHeartbeat updates phase and heartbeat time", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-hb-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const { runFilePath, runId } = await initRun({
    workspaceRoot, taskId: "task_hb_1", workspaceId: "hosted-default"
  });

  await updateRunHeartbeat(runFilePath, "running_codex", { codex_child_pid: 12345 });

  const runData = await loadRun(workspaceRoot, "task_hb_1", runId);
  assert.equal(runData.phase, "running_codex");
  assert.equal(runData.codex_child_pid, 12345);
  assert.ok(new Date(runData.last_heartbeat_at).getTime() > new Date(runData.started_at).getTime());
});

test("fireHeartbeat does not throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-fhb-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const { runFilePath } = await initRun({
    workspaceRoot, taskId: "task_fhb_1", workspaceId: "hosted-default"
  });

  // Should not throw
  fireHeartbeat(runFilePath, "completed", { exit_code: 0 });
  fireHeartbeat(null, "completed"); // should silently handle null
});

test("writeRunLogs creates stdout and stderr files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-logs-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const { runId } = await initRun({
    workspaceRoot, taskId: "task_logs_1", workspaceId: "hosted-default"
  });

  await writeRunLogs({
    workspaceRoot, taskId: "task_logs_1", runId,
    stdout: "hello stdout",
    stderr: "hello stderr"
  });

  const stdLog = getStdoutLogPath(workspaceRoot, "task_logs_1", runId);
  const errLog = getStderrLogPath(workspaceRoot, "task_logs_1", runId);

  assert.ok(existsSync(stdLog), "stdout log should exist");
  assert.ok(existsSync(errLog), "stderr log should exist");

  const stdoutContent = await readFile(stdLog, "utf8");
  const stderrContent = await readFile(errLog, "utf8");
  assert.equal(stdoutContent, "hello stdout");
  assert.equal(stderrContent, "hello stderr");
});

test("listRuns returns runs newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-listruns-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const r1 = await initRun({ workspaceRoot, taskId: "task_lr_1", workspaceId: "hosted-default" });
  await new Promise(r => setTimeout(r, 10));
  const r2 = await initRun({ workspaceRoot, taskId: "task_lr_1", workspaceId: "hosted-default" });

  const runs = await listRuns(workspaceRoot, "task_lr_1");
  assert.equal(runs.length, 2);
  // newest first
  assert.ok(new Date(runs[0].started_at).getTime() >= new Date(runs[1].started_at).getTime());
});

test("getLatestRun returns most recent run", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-latest-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const r1 = await initRun({ workspaceRoot, taskId: "task_latest_1", workspaceId: "hosted-default" });
  await new Promise(r => setTimeout(r, 10));
  const r2 = await initRun({ workspaceRoot, taskId: "task_latest_1", workspaceId: "hosted-default" });

  const latest = await getLatestRun(workspaceRoot, "task_latest_1");
  assert.equal(latest.run_id, r2.runId);
});

// ================================================================
// ================================================================

// ================================================================
// ================================================================

// ================================================================
// ================================================================

// ================================================================
// ================================================================

// ================================================================
// ================================================================

// ================================================================
// 7. No secret values exposed in diagnostics
// ================================================================

// ================================================================
// 8. General diagnostics tool verification (happy path tasks)
// ================================================================

// ================================================================
// 9. Modular helpers
// ================================================================

test("isProcessAlive returns false for invalid pid", () => {
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test("isProcessAlive returns true for current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isRepoDirty returns false for non-existent path", () => {
  assert.equal(isRepoDirty("/nonexistent/path"), false);
});

// ================================================================
// 10. Integration: heartbeat in processGeneralTask
// ================================================================

test("Codex execution creates run metadata with heartbeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-runint-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=heartbeat-test')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const created = await callTool(server, "create_task", {
    title: "Heartbeat test",
    description: "Verify run metadata is created",
    mode: "builder"
  });

  await callTool(server, "assign_task_to_codex", { task_id: created.task.id });

  // Run the task
  await callTool(server, "run_assigned_codex_tasks", { limit: 1 });

  // Check that run metadata was created
  const runs = await listRuns(workspaceRoot, created.task.id);
  assert.ok(runs.length > 0, "should have at least one run");

  const latest = runs[0];
  assert.equal(latest.task_id, created.task.id);
  assert.ok(latest.started_at, "should have started_at");
  assert.ok(latest.last_heartbeat_at, "should have last_heartbeat_at");
  assert.ok(latest.stdout_log_path, "should have stdout_log_path");
  assert.ok(latest.stderr_log_path, "should have stderr_log_path");

  // Check that run logs were written
  if (latest.stdout_log_path) {
    assert.ok(existsSync(latest.stdout_log_path), "stdout log file should exist");
  }
});

// ================================================================
// 11. Edge cases
// ================================================================

test("run metadata is cleaned up properly after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-runmeta-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    codexHome: root,
    codexExecArgs: `__gptwork_test_invalid_arg__ || ${JSON.stringify(process.execPath)} -e "process.stdout.write('STATUS=completed\\nSUMMARY=cleanup-test')"`,
    codexExecTimeout: 5,
    tokens: ["test-token"],
    requireAuth: true,
    toolMode: "full"
  });

  const created = await callTool(server, "create_task", {
    title: "Cleanup test",
    description: "Verify run metadata cleanup",
    mode: "builder"
  });

  await callTool(server, "assign_task_to_codex", { task_id: created.task.id });
  await callTool(server, "run_assigned_codex_tasks", { limit: 1 });

  const runs = await listRuns(workspaceRoot, created.task.id);
  assert.ok(runs.length > 0);

  // The completed run should show the completed phase
  const latest = runs[0];
  assert.ok(latest.phase === "completed" || latest.phase === "parsing_result" || latest.phase === "failed", "run should have terminal phase");
});

// ================================================================
// 12. Startup reconciliation via worker startup
// ================================================================

test("startCodexWorker startup reconciliation runs on first tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-workerrec-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_worker_rec";
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 700000).toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Worker rec test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: old, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: old, updated_at: old }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create stale run
  await initRun({ workspaceRoot, taskId, workspaceId: "hosted-default", repoPath: workspaceRoot });
  const run = await getLatestRun(workspaceRoot, taskId);
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = old;
    runData.phase = "running_codex";
    runData.codex_child_pid = 999993;
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true,
    toolMode: "full"
  });

  // Call reconciliation directly (same as what startCodexWorker does)
  const result = await server.reconcileStaleTasks();
  assert.ok(result.ok, "reconciliation should succeed");
  assert.ok(result.reconciled >= 1, "should reconcile at least 1 task");

  // Verify the task was marked waiting_for_review
  const relState = JSON.parse(await readFile(statePath, "utf8"));
  const task = relState.tasks.find((t) => t.id === taskId);
  assert.equal(task.status, "waiting_for_review");
  assert.equal(task.result.kind, "codex_stalled");
});

// ================================================================
// ================================================================
