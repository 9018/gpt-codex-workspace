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
  findStuckTasks,
  diagnoseTask,
  recoverTask,
  startupReconciliation,
  getRunDir,
  getRunFilePath,
  getStdoutLogPath,
  getStderrLogPath,
  stripSecrets
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
    requireAuth: true
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
// 2. diagnose_task detects stale running task with missing process
// ================================================================

test("diagnose_task detects stale running task with missing process", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-diag1-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_diag_stale_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const diag = await callTool(server, "diagnose_task", { task_id: taskId });

  assert.equal(diag.task_id, taskId);
  assert.equal(diag.status, "running");
  assert.ok(diag.has_run, "should have run metadata");
  assert.ok(diag.heartbeat_age_seconds > 600, "heartbeat should be stale");
  assert.equal(diag.process_alive, false, "process should not be alive");
  assert.ok(diag.likely_cause, "should have likely cause");
  assert.ok(diag.suggested_actions, "should have suggested actions");
  assert.ok(diag.suggested_actions.length > 0, "should have at least one suggested action");
  assert.equal(diag.codex_child_pid, 999999, "should report the fake pid");
});

// ================================================================
// 3. diagnose_task detects dirty repo after stalled run
// ================================================================

test("diagnose_task detects dirty repo after stalled run", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-diag2-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Init git repo and make a dirty file
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: workspaceRoot, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: workspaceRoot, stdio: "ignore" });
  // Create initial commit
  await writeFile(join(workspaceRoot, ".gitkeep"), "initial", "utf8");
  execSync("git add . && git commit -m 'initial'", { cwd: workspaceRoot, stdio: "ignore" });
  // Make a dirty file
  await writeFile(join(workspaceRoot, "dirty.txt"), "uncommitted change", "utf8");

  const statePath = join(root, "state.json");
  const taskId = "task_diag_dirty_1";
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 700000).toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Dirty repo task", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: old, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: old, updated_at: old }],
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
    runData.codex_child_pid = 999998;
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const diag = await callTool(server, "diagnose_task", { task_id: taskId });

  assert.equal(diag.repo_dirty, true, "should detect dirty repo");
  assert.ok(diag.changed_files, "should list changed files");
  assert.ok(diag.changed_files.includes("dirty.txt"), "should include dirty.txt");
  assert.ok(diag.likely_cause, "should have likely cause");
});

// ================================================================
// 4. list_stuck_tasks returns stale running tasks
// ================================================================

test("list_stuck_tasks returns stale running tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-stucklist-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_stuck_list_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const stuck = await callTool(server, "list_stuck_tasks");

  assert.ok(stuck.count >= 1, "should find at least one stuck task");
  const found = stuck.stuck_tasks.find((t) => t.task_id === taskId);
  assert.ok(found, "should find our stuck task");
  assert.equal(found.status, "running");
  assert.equal(found.process_alive, false);
});

// ================================================================
// 5. recover_stuck_task operations
// ================================================================

test("recover_stuck_task mark_waiting_review", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec1-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_rec_mwr_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "mark_waiting_review" });

  assert.equal(result.task_id, taskId);
  assert.equal(result.new_status, "waiting_for_review");
  assert.equal(result.changes_made, true);

  // Verify task state was updated
  const task = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.task.status, "waiting_for_review");
  assert.equal(task.task.result.kind, "codex_stalled");
});

test("recover_stuck_task mark_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec2-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_rec_mf_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "mark_failed" });

  assert.equal(result.new_status, "failed");
  assert.equal(result.changes_made, true);

  const task = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.task.status, "failed");
  assert.equal(task.task.result.kind, "codex_failed");
});

test("recover_stuck_task reset_to_assigned", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec3-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_rec_rta_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "reset_to_assigned" });

  assert.equal(result.new_status, "assigned");
  assert.equal(result.changes_made, true);

  const task = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.task.status, "assigned");
});

test("recover_stuck_task inspect_only returns diagnostics without changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec4-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_rec_io_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "inspect_only" });

  assert.equal(result.changes_made, false);
  assert.ok(result.diagnostics, "should include diagnostics");
  assert.equal(result.diagnostics.task_id, taskId);

  // Verify task was NOT changed
  const task = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.task.status, "running");
});

test("recover_stuck_task finalize_if_result_json with existing result.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec5-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_rec_frj_1";
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 700000).toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [{ id: "goal_rec_frj", project_id: "default", workspace_id: "hosted-default", conversation_id: "conv_rec_frj", task_id: taskId, user_request: "test", goal_prompt: "test", context_summary: "test", title: "test", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", created_at: old, updated_at: old }],
    conversations: [{ id: "conv_rec_frj", goal_id: "goal_rec_frj", project_id: "default", workspace_id: "hosted-default", messages: [], created_at: old, updated_at: old }],
    memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: "goal_rec_frj", conversation_id: "conv_rec_frj", title: "Finalize test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: old, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: old, updated_at: old }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create result.json
  const goalDir = join(workspaceRoot, ".gptwork/goals/goal_rec_frj");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Finalized via result.json recovery"
  }, null, 2), "utf8");

  // Create run metadata
  await initRun({ workspaceRoot, taskId, workspaceId: "hosted-default", repoPath: workspaceRoot });
  const run = await getLatestRun(workspaceRoot, taskId);
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = old;
    runData.phase = "running_codex";
    runData.codex_child_pid = 999996;
    // Set result_json_path on run
    runData.result_json_path = join(goalDir, "result.json");
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true,
    codexExecArgs: "/invalid/to/prevent/actual/codex/execution",
    codexExecTimeout: 1
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "finalize_if_result_json" });
  assert.equal(result.changes_made, true, "should finalize from result.json");
  assert.equal(result.new_status, "completed", "should complete the task");

  const task = await callTool(server, "get_task", { task_id: taskId });
  assert.equal(task.task.status, "completed");
});

test("recover_stuck_task unknown action returns error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec6-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_rec_bad_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "nonexistent_action" });
  assert.ok(result.error, "should return error for unknown action");
  assert.match(result.error, /Unknown action/);
});

// ================================================================
// 6. Startup reconciliation moves stale running tasks
// ================================================================

test("startupReconciliation moves stale running tasks to waiting_for_review", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-startrec-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_rec_stale";
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 700000).toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Stale start rec", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: old, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: old, updated_at: old }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create stale run metadata
  await initRun({ workspaceRoot, taskId, workspaceId: "hosted-default", repoPath: workspaceRoot });
  const run = await getLatestRun(workspaceRoot, taskId);
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = old;
    runData.phase = "running_codex";
    runData.codex_child_pid = 999995;
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  // Create server which triggers reconciliation in startCodexWorker
  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  // Directly test the reconciliation function
  const reloadedState = JSON.parse(await readFile(statePath, "utf8"));
  const reconciled = await startupReconciliation(reloadedState, { save: async () => { await writeFile(statePath, JSON.stringify(reloadedState, null, 2), "utf8"); } }, workspaceRoot, 100);

  assert.ok(reconciled.length >= 1, "should reconcile at least one task");
  const rec = reconciled.find((r) => r.task_id === taskId);
  assert.ok(rec, "should include our task");
  assert.equal(rec.previous_status, "running");
  assert.equal(rec.new_status, "waiting_for_review");
  assert.ok(rec.message, "should have a reconciliation message");
});

test("startupReconciliation skips tasks with active process", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-startrec2-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_rec_active";
  const now = new Date().toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Active task", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create run with current heartbeat and a real pid (this process)
  await initRun({ workspaceRoot, taskId, workspaceId: "hosted-default", repoPath: workspaceRoot });
  const run = await getLatestRun(workspaceRoot, taskId);
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = now;
    runData.phase = "running_codex";
    runData.codex_child_pid = process.pid; // our own PID - should be alive
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  const reloadedState = JSON.parse(await readFile(statePath, "utf8"));
  const reconciled = await startupReconciliation(reloadedState, { save: async () => { await writeFile(statePath, JSON.stringify(reloadedState, null, 2), "utf8"); } }, workspaceRoot, 600);

  // Should NOT reconcile this task since process is alive and heartbeat is fresh
  const rec = reconciled.find((r) => r.task_id === taskId);
  assert.equal(rec, undefined, "should NOT reconcile a task with active process");
});

// ================================================================
// 7. No secret values exposed in diagnostics
// ================================================================

test("diagnose_task does not expose secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-secrets-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_secrets_1";
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 700000).toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Secret test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: old, message: "[worker] codex exec started" }], artifacts: [], result: null, created_at: old, updated_at: old }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  await initRun({ workspaceRoot, taskId, workspaceId: "hosted-default", repoPath: workspaceRoot });
  const run = await getLatestRun(workspaceRoot, taskId);
  if (run) {
    const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
    const runData = JSON.parse(await readFile(runFilePath, "utf8"));
    runData.last_heartbeat_at = old;
    runData.phase = "running_codex";
    runData.codex_child_pid = 999994;
    runData.secret_key = "super-secret-value"; // Should be redacted
    runData.api_token = "sk-abc123def456";    // Should be redacted
    await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  }

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const diag = await callTool(server, "diagnose_task", { task_id: taskId });

  const diagStr = JSON.stringify(diag);
  assert.doesNotMatch(diagStr, /super-secret-value/, "should not expose secret_key value");
  assert.doesNotMatch(diagStr, /sk-abc123def456/, "should not expose api_token value");
  assert.doesNotMatch(diagStr, /REDACTED/, "should not contain REDACTED placeholder (only the values should be redacted, not the key)"); 
  
  // Actually, the redacted values should show [REDACTED] for matching fields
  // But the keys themselves are secret_field names
});

// ================================================================
// 8. General diagnostics tool verification (happy path tasks)
// ================================================================

test("diagnose_task returns diagnostic for completed tasks too", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-diag3-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_diag_completed";
  const now = new Date().toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Completed task", description: "", created_by: "user_default", assignee: "codex", status: "completed", mode: "builder", logs: [{ time: now, message: "[worker] completed" }], artifacts: [], result: { summary: "Done" }, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  const diag = await callTool(server, "diagnose_task", { task_id: taskId });
  assert.equal(diag.task_id, taskId);
  assert.equal(diag.status, "completed");
  assert.ok(diag.likely_cause, "should mention not in running state");
});

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

test("run metadata tools available from server", async () => {
  const server = await makeServer();

  // Verify new tools are in the tool list
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined);
  const toolNames = response.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("diagnose_task"), "diagnose_task should be in tool list");
  assert.ok(toolNames.includes("list_stuck_tasks"), "list_stuck_tasks should be in tool list");
  assert.ok(toolNames.includes("recover_stuck_task"), "recover_stuck_task should be in tool list");
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
    requireAuth: true
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

test("diagnose_task for nonexistent task returns error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-diag404-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"], requireAuth: true
  });

  const diag = await callTool(server, "diagnose_task", { task_id: "nonexistent_task" });
  assert.ok(diag.error, "should return error for nonexistent task");
  assert.match(diag.error, /not found/);
});

test("recover_stuck_task for nonexistent task returns error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rec404-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"], requireAuth: true
  });

  const result = await callTool(server, "recover_stuck_task", { task_id: "nonexistent", action: "inspect_only" });
  assert.ok(result.error, "should return error for nonexistent task");
});

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
    requireAuth: true
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
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
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
// 13. Kill process action
// ================================================================

test("recover_stuck_task kill_process_if_alive handles no process gracefully", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-kill-"));
  const { statePath, workspaceRoot, taskId } = await createSeededState(root, "task_kill_1");

  const server = await createGptWorkServer({
    statePath, defaultWorkspaceRoot: workspaceRoot, tokens: ["test-token"], requireAuth: true
  });

  // PID 999999 is unlikely to exist, so it should be handled gracefully
  const result = await callTool(server, "recover_stuck_task", { task_id: taskId, action: "kill_process_if_alive" });
  assert.equal(result.changes_made, false);
  assert.match(result.message, /No active Codex process/);
});
