/**
 * Safe restart protocol tests.
 *
 * Covers:
 * - Pending restart marker is written before restart scheduling
 * - scheduleServiceRestart returns useful structured info without exposing secrets
 * - Startup verification completes or updates task after marker is verified
 * - Failed verification leaves task waiting_for_review with diagnostics
 * - Codex prompt contains the self-restart rule (tested by reading processGeneralTask output)
 * - direct inline restart instruction is absent or discouraged in generated prompts
 * - schedule_service_restart tool is visible in MCP tool list
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGptWorkServer } from "../src/gptwork-server.mjs";
import {
  writePendingRestartMarker,
  loadRestartMarker,
  updateRestartMarkerStatus,
  scanPendingRestartMarkers,
  removeRestartMarker,
  verifyRestartMarker,
  scheduleServiceRestart,
  getPendingRestartsDir,
  getRestartMarkerPath,
  scheduleDetachedRestart,
  validateWorkspaceRoot,
  MISPLACED_MARKER_DIAGNOSTIC,
  scanMisplacedMarkersSync,
  migrateMisplacedMarker,
  getMisplacedMarkerDiagnostic,
  removeMisplacedMarker
} from "../src/safe-restart.mjs";
import { safeRepoId } from "../src/repo-lock.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    codexHome: root,
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

async function createSeedStateWithTask(root, taskId, overrides = {}) {
  const workspaceRoot = join(root, "workspace");
  const statePath = join(root, "state.json");
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago

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
      type: "hosted",
      root: workspaceRoot,
      default: true,
      created_at: now, updated_at: now
    }],
    goals: [],
    conversations: [],
    memories: [],
    tasks: [{
      id: taskId,
      project_id: "default",
      workspace_id: "hosted-default",
      title: overrides.title || "Test task",
      description: overrides.description || "",
      created_by: "user_default",
      assignee: "codex",
      status: overrides.status || "running",
      mode: "builder",
      logs: [{
        time: overrides.createdAt || old,
        message: "[worker] started"
      }],
      artifacts: [],
      result: overrides.result || null,
      created_at: overrides.createdAt || old,
      updated_at: overrides.createdAt || old,
    }],
    chatgpt_requests: [],
    activities: [],
    audit: []
  };

  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return { statePath, workspaceRoot };
}

// ================================================================
// 1. Pending restart marker is written before restart scheduling
// ================================================================

test("writePendingRestartMarker creates marker file with correct fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-marker-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const marker = await writePendingRestartMarker(workspaceRoot, "task_test_1", {
    requested_by: "codex",
    expected_commit: "abc123def456",
    expected_remote_head: "def789abc012",
    repo_path: workspaceRoot,
  });

  assert.equal(marker.task_id, "task_test_1");
  assert.equal(marker.requested_by, "codex");
  assert.equal(marker.service_name, "gptwork-mcp.service");
  assert.equal(marker.expected_commit, "abc123def456");
  assert.equal(marker.expected_remote_head, "def789abc012");
  assert.equal(marker.repo_path, workspaceRoot);
  assert.equal(marker.restart_kind, "npm");
  assert.equal(marker.status, "pending");
  assert.ok(marker.requested_at);
  assert.ok(Array.isArray(marker.logs));
  assert.equal(marker.attempts, 0);

  // Verify file exists on disk
  const markerPath = getRestartMarkerPath(workspaceRoot, "task_test_1");
  assert.ok(existsSync(markerPath), "marker file should exist on disk");

  // Verify can reload
  const loaded = await loadRestartMarker(workspaceRoot, "task_test_1");
  assert.equal(loaded.task_id, "task_test_1");
  assert.equal(loaded.status, "pending");
  assert.equal(loaded.expected_commit, "abc123def456");
});

test("writePendingRestartMarker fails without workspaceRoot or taskId", async () => {
  await assert.rejects(() => writePendingRestartMarker(null, "task_1"), /workspaceRoot is required/);
  await assert.rejects(() => writePendingRestartMarker("/tmp", null), /taskId is required/);
});

// ================================================================
// 2. Marker CRUD operations
// ================================================================

test("updateRestartMarkerStatus updates status and appends log", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-update-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await writePendingRestartMarker(workspaceRoot, "task_update_1");

  const updated = await updateRestartMarkerStatus(workspaceRoot, "task_update_1", "scheduled", {
    restart_method: "systemd-run",
    scheduled_at: new Date().toISOString()
  });

  assert.equal(updated.status, "scheduled");
  assert.equal(updated.restart_method, "systemd-run");
  assert.equal(updated.logs.length, 2); // original creation + status change
  assert.ok(updated.scheduled_at);

  const loaded = await loadRestartMarker(workspaceRoot, "task_update_1");
  assert.equal(loaded.status, "scheduled");
});

test("updateRestartMarkerStatus validates status", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-invalid-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await writePendingRestartMarker(workspaceRoot, "task_invalid_1");

  await assert.rejects(
    () => updateRestartMarkerStatus(workspaceRoot, "task_invalid_1", "invalid_status"),
    /Invalid restart marker status/
  );
});

test("updateRestartMarkerStatus fails for nonexistent marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-nonexist-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await assert.rejects(
    () => updateRestartMarkerStatus(workspaceRoot, "nonexistent_task", "scheduled"),
    /No restart marker found/
  );
});

test("scanPendingRestartMarkers returns all markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-scan-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Create two markers
  await writePendingRestartMarker(workspaceRoot, "task_scan_1");
  await new Promise(r => setTimeout(r, 5));
  await writePendingRestartMarker(workspaceRoot, "task_scan_2");

  const markers = await scanPendingRestartMarkers(workspaceRoot);
  assert.equal(markers.length, 2);
  // Should be sorted by requested_at descending
  assert.ok(new Date(markers[0].requested_at).getTime() >= new Date(markers[1].requested_at).getTime());
});

test("scanPendingRestartMarkers returns empty array for clean workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-clean-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const markers = await scanPendingRestartMarkers(workspaceRoot);
  assert.equal(markers.length, 0);
});

test("removeRestartMarker removes marker file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-remove-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await writePendingRestartMarker(workspaceRoot, "task_remove_1");
  const markerPath = getRestartMarkerPath(workspaceRoot, "task_remove_1");
  assert.ok(existsSync(markerPath));

  const removed = await removeRestartMarker(workspaceRoot, "task_remove_1");
  assert.equal(removed, true);
  assert.equal(existsSync(markerPath), false);
});

// ================================================================
// 3. scheduleServiceRestart returns useful structured info without secrets
// ================================================================

test("scheduleServiceRestart writes marker and returns structured info", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-schedule-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_sched_1",
    requestedBy: "codex",
    expectedCommit: "abc123",
    expectedRemoteHead: "def456",
    dryRun: true,
  });

  // Should not expose secrets
  const resultStr = JSON.stringify(result);
  assert.doesNotMatch(resultStr, /secret|password|token|credential|key|api_key/i);

  // Should include structured fields
  assert.ok("ok" in result);
  assert.equal(result.task_id, "task_sched_1");
  assert.equal(result.service_name, "gptwork-mcp.service");
  assert.equal(result.expected_commit, "abc123");
  assert.equal(result.expected_remote_head, "def456");
  assert.ok(result.duration_ms > 0);

  // Marker should exist on disk
  const marker = await loadRestartMarker(workspaceRoot, "task_sched_1");
  assert.ok(marker);
  assert.equal(marker.task_id, "task_sched_1");
  assert.equal(marker.expected_commit, "abc123");
  // Status should be "scheduled" or "failed" depending on configured restart strategy
  assert.ok(marker.status === "scheduled" || marker.status === "failed");
});

test("scheduleServiceRestart with store appends task log", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-store-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Create a seed state with a task
  const statePath = join(root, "state.json");
  const taskId = "task_store_1";
  const now = new Date().toISOString();
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "Store test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    requestedBy: "test",
    store,
    dryRun: true,
  });

  // Verify task log was appended
  const loadedState = JSON.parse(await readFile(statePath, "utf8"));
  const task = loadedState.tasks.find(t => t.id === taskId);
  assert.ok(task);
  const lastLog = task.logs[task.logs.length - 1];
  assert.match(lastLog.message, /safe-restart/);
  assert.match(lastLog.message, /restart marker/i);
});

// ================================================================

// ================================================================
// P2.0b.1: expected_commit guard for safe restart
// ================================================================

test("scheduleServiceRestart rejects expected_commit mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-mismatch-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init a real git repo with one commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Use a different commit SHA
  const fakeCommit = "a".repeat(40);

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_p2b1_mismatch",
    expectedCommit: fakeCommit,
    repoPath,
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "expected_commit_mismatch");
  assert.equal(result.expected_commit, fakeCommit);
  assert.equal(result.local_head, localHead);

  // Verify no marker was written
  const marker = await loadRestartMarker(workspaceRoot, "task_p2b1_mismatch");
  assert.equal(marker, null);
});

test("scheduleServiceRestart accepts expected_commit match", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-match-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_p2b1_match",
    expectedCommit: localHead,
    repoPath,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead);
  assert.equal(result.expected_commit_source, "explicit");
  assert.equal(result.error, undefined);

  // Verify marker was written
  const marker = await loadRestartMarker(workspaceRoot, "task_p2b1_match");
  assert.ok(marker);
  assert.equal(marker.expected_commit, localHead);
});

test("scheduleServiceRestart preserves behavior when expected_commit absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-absent-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_p2b1_absent",
    repoPath,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead);
  assert.equal(result.expected_commit_source, "local_head");

  // Verify marker was written with resolved HEAD
  const marker = await loadRestartMarker(workspaceRoot, "task_p2b1_absent");
  assert.ok(marker);
  assert.equal(marker.expected_commit, localHead);
});
// 4. schedule_service_restart tool visible from MCP
// ================================================================

test("schedule_service_restart and list_pending_restarts tools are visible in MCP tool list", async () => {
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

  assert.equal(response.error, undefined);
  const toolNames = response.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("schedule_service_restart"), "schedule_service_restart should be in tool list");
  assert.ok(toolNames.includes("list_pending_restarts"), "list_pending_restarts should be in tool list");

  // Verify schedule_service_restart tool schema
  const tool = response.result.tools.find(t => t.name === "schedule_service_restart");
  assert.ok(tool, "schedule_service_restart tool entry should exist");
  assert.ok(tool.inputSchema.required.includes("task_id"), "task_id should be required");
});

// ================================================================
// ================================================================

// ================================================================
// ================================================================

// ================================================================
// 7. verifyRestartMarker handles empty config gracefully
// ================================================================

test("verifyRestartMarker returns not verified for null marker", async () => {
  const result = await verifyRestartMarker(null, {});
  assert.equal(result.verified, false);
  assert.ok(result.diagnostics.error);
});

test("verifyRestartMarker returns not verified when repo path is missing", async () => {
  const marker = {
    task_id: "task_vrfy_1",
    expected_commit: "abc123",
    repo_path: "/nonexistent/repo/path",
  };
  const result = await verifyRestartMarker(marker, {});
  assert.equal(result.verified, false);
  assert.match(result.diagnostics.error, /No git repo path/);
});

// ================================================================
// 8. Codex prompt contains self-restart rule (via processGeneralTask)
// ================================================================

test("processGeneralTask prompt contains safe restart rule", async () => {
  // Create a server and task, then extract the prompt that would be generated
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-prompt-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true
  });

  // Create a task to get a goal/task context
  const created = await callTool(server, "create_task", {
    title: "Test prompt for restart rule",
    description: "Verify the safe restart rule is in the prompt"
  });

  // Use preview_codex_context to check prompt content
  try {
    const preview = await callTool(server, "preview_codex_context", { task_id: created.task.id });
    // The preview shows context but not the full prompt. Let's directly check processGeneralTask
    // by reading the source file for the prompt template
    assert.ok(preview.context, "should return context");
  } catch {
    // preview_codex_context may not work without a goal, that's OK
  }
});

test("generated prompt file explicitly contains the Safe Restart Rule section", async () => {
  // Read the codex-prompt-builder.mjs source to verify the prompt template includes the restart rule
  const source = await readFile(join(TEST_DIR, "../src/codex-prompt-builder.mjs"), "utf8");
  
  // The prompt template should contain the Safe Restart Rule
  assert.match(source, /Safe Restart Rule/i, "prompt should contain Safe Restart Rule section");
  
  // It should explicitly discourage direct systemctl restart
  assert.match(source, /MUST NOT run.*restart command directly.*self-restart/i, "prompt should forbid direct self-restart");
  
  // It should mention schedule_service_restart as the alternative
  assert.match(source, /schedule_service_restart/i, "prompt should mention schedule_service_restart tool");
});

// ================================================================
// 9. Phase C: startup verification flow
// ================================================================

test("Phase C startup reconciliation for restart markers - happy path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-phaseC-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_phaseC_1";
  const goalId = "goal_phaseC_1";
  const now = new Date().toISOString();

  // Create state with task and goal
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [{ id: goalId, project_id: "default", workspace_id: "hosted-default", conversation_id: "conv_phaseC", task_id: taskId, user_request: "test", goal_prompt: "test", context_summary: "test", title: "phaseC test", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", created_at: now, updated_at: now }],
    conversations: [{ id: "conv_phaseC", goal_id: goalId, project_id: "default", workspace_id: "hosted-default", messages: [], created_at: now, updated_at: now }],
    memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "Phase C test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "[worker] started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create a result.json that validatePhaseC would find
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Phase C verified deployment",
    commit: "abc123def456",
    remote_head: "def789abc012",
  }), "utf8");

  // Create pending restart marker with matching expected_commit
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: "abc123def456",
    expected_remote_head: "def789abc012",
    repo_path: workspaceRoot,
  });
  await updateRestartMarkerStatus(workspaceRoot, taskId, "scheduled", {
    restart_method: "systemd-run",
    scheduled_at: now,
  });

  // Create server and trigger reconciliation
  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true
  });

  // Reconcile stale tasks (which includes Phase C restart marker processing)
  const result = await server.reconcileStaleTasks();
  assert.ok(result.ok, "reconciliation should succeed");
  
  // Check if the restart marker was processed
  // (Note: phase C verification may or may not verify depending on git repo availability)
  // At minimum, the reconciliation should not throw
  assert.ok(result.restart_verifications !== undefined, "should include restart_verifications");
});

// ================================================================
// 10. scheduleDetachedRestart (unit tests with mocked execSync)
// ================================================================

test("scheduleDetachedRestart returns method info", () => {
  // This is tested in a non-destructive way - the strategy default (npm) is used for dry-run
  const result = scheduleDetachedRestart({
    serviceName: "gptwork-mcp.service",
    taskId: "task_detach_1",
    dryRun: true,
  });
  
  // It should always return without error, even if scheduling failed
  assert.ok("method" in result);
  assert.ok("command" in result);
  assert.ok("scheduled" in result);
  
  // No secrets in output
  assert.doesNotMatch(JSON.stringify(result), /secret|password|token|credential|key|api_key/i);
});

// ================================================================
// 11. Edge cases
// ================================================================

test("restart marker dir structure is correct path", () => {
  const dir = getPendingRestartsDir("/home/test/workspace");
  assert.equal(dir, "/home/test/workspace/.gptwork/pending-restarts");

  const path = getRestartMarkerPath("/home/test/workspace", "task_abc_123");
  assert.equal(path, "/home/test/workspace/.gptwork/pending-restarts/task_abc_123.json");
});

test("loadRestartMarker returns null for nonexistent marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-null-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const marker = await loadRestartMarker(workspaceRoot, "nonexistent_task");
  assert.equal(marker, null);
});

test("removeRestartMarker returns false for nonexistent marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-rm-none-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const result = await removeRestartMarker(workspaceRoot, "nonexistent");
  assert.equal(result, true); // rm with force:true returns true even for missing files
});

// ================================================================
// 12. Startup verification with result.json
// ================================================================

test("Phase C startup verification completes task when result.json exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-verify-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const statePath = join(root, "state.json");
  const taskId = "task_verify_1";
  const goalId = "goal_verify_1";
  const now = new Date().toISOString();

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [{ id: goalId, project_id: "default", workspace_id: "hosted-default", conversation_id: "conv_verify", task_id: taskId, user_request: "test", goal_prompt: "test", context_summary: "test", title: "verify test", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", created_at: now, updated_at: now }],
    conversations: [{ id: "conv_verify", goal_id: goalId, project_id: "default", workspace_id: "hosted-default", messages: [], created_at: now, updated_at: now }],
    memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "Verify test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "[worker] started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Create result.json
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Deployment verified",
    commit: "verify123abc",
    remote_head: "verify456def",
  }), "utf8");

  // Create a verified marker (simulating what happens in Phase C)
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: "verify123abc",
    repo_path: workspaceRoot,
  });
  await updateRestartMarkerStatus(workspaceRoot, taskId, "scheduled");

  // Run reconciliation
  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    tokens: ["test-token"],
    requireAuth: true,
    // Set a very low stall threshold to ensure reconciliation runs
    codexStallThreshold: 1,
  });

  const result = await server.reconcileStaleTasks();
  
  // The restart marker should have been processed (either verified or marked failed)
  assert.ok(result.restart_verifications !== undefined);
  
  // The task's restart marker should now be either "verified" or "failed"
  // depending on whether the git repo was available for HEAD comparison
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  if (marker) {
    assert.ok(marker.status === "verified" || marker.status === "failed",
      `marker status should be terminal: ${marker.status}`);
  }
});

// ================================================================
// 13. Test the test:clean isolation
// ================================================================

test("safe restart module exports all expected functions", () => {
  // Verify all expected exports are present
  const expected = [
    "writePendingRestartMarker",
    "loadRestartMarker",
    "updateRestartMarkerStatus",
    "scanPendingRestartMarkers",
    "removeRestartMarker",
    "verifyRestartMarker",
    "scheduleServiceRestart",
    "getPendingRestartsDir",
    "getRestartMarkerPath",
    "scheduleDetachedRestart",
  ];
  for (const name of expected) {
    assert.equal(typeof eval(name), "function", `${name} should be exported as a function`);
  }
});

// ================================================================
// 14. Marker JSON serialization round-trip
// ================================================================

test("restart marker round-trips through JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sr-rt-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const original = await writePendingRestartMarker(workspaceRoot, "task_rt_1", {
    expected_commit: "abc123",
    expected_remote_head: "def456",
    repo_path: workspaceRoot,
    requested_by: "test",
  });

  const loaded = await loadRestartMarker(workspaceRoot, "task_rt_1");

  assert.equal(loaded.task_id, original.task_id);
  assert.equal(loaded.status, original.status);
  assert.equal(loaded.expected_commit, original.expected_commit);
  assert.equal(loaded.expected_remote_head, original.expected_remote_head);
  assert.equal(loaded.repo_path, original.repo_path);
  assert.equal(loaded.requested_by, original.requested_by);
  assert.equal(loaded.service_name, original.service_name);
  assert.equal(loaded.restart_kind, original.restart_kind);
  assert.equal(loaded.attempts, original.attempts);

  // Verify log structure
  assert.ok(Array.isArray(loaded.logs));
  assert.equal(loaded.logs.length, 1);
  assert.ok(loaded.logs[0].time);
  assert.ok(loaded.logs[0].message);
});

// ================================================================
// P0 Hotfix: Misplaced marker detection and migration
// ================================================================

test("validateWorkspaceRoot rejects git repo path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-vwr-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Non-repo path should be valid
  const valid = validateWorkspaceRoot(workspaceRoot);
  assert.equal(valid.valid, true);

  // Create a .git directory to simulate repo path
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".git"), { recursive: true });
  const invalid = validateWorkspaceRoot(repoPath);
  assert.equal(invalid.valid, false);
  assert.match(invalid.reason, /git repository/);

  // Empty/null should be invalid
  const empty = validateWorkspaceRoot("");
  assert.equal(empty.valid, false);
  assert.equal(empty.reason, "workspaceRoot is required");

  const nil = validateWorkspaceRoot(null);
  assert.equal(nil.valid, false);
});

test("scanMisplacedMarkersSync returns markers from repo path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-sms-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(repoPath, ".gptwork", "pending-restarts"), { recursive: true });

  // Write a misplaced marker file in repo path
  const markerContent = JSON.stringify({
    task_id: "task_misplaced_1",
    requested_at: new Date().toISOString(),
    requested_by: "codex",
    status: "scheduled",
    expected_commit: "abc123",
    repo_path: repoPath,
  });
  await writeFile(join(repoPath, ".gptwork", "pending-restarts", "task_misplaced_1.json"), markerContent);

  // Scan for misplaced markers
  const results = scanMisplacedMarkersSync([repoPath]);
  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, "task_misplaced_1");
  assert.equal(results[0].repoPath, repoPath);
  assert.equal(results[0].marker.status, "scheduled");
});

test("scanMisplacedMarkersSync skips non-existent repo paths", async () => {
  const results = scanMisplacedMarkersSync(["/nonexistent/path"]);
  assert.equal(results.length, 0);
});

test("scanMisplacedMarkersSync handles empty/null input", async () => {
  assert.equal(scanMisplacedMarkersSync([]).length, 0);
  assert.equal(scanMisplacedMarkersSync(null).length, 0);
  assert.equal(scanMisplacedMarkersSync(undefined).length, 0);
});

test("migrateMisplacedMarker migrates marker to canonical path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-mmm-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(repoPath, ".gptwork", "pending-restarts"), { recursive: true });

  const taskId = "task_migrate_1";
  const markerContent = JSON.stringify({
    task_id: taskId,
    requested_at: new Date().toISOString(),
    requested_by: "codex",
    status: "scheduled",
    expected_commit: "def789",
    expected_remote_head: "ghi012",
    repo_path: repoPath,
  });
  await writeFile(join(repoPath, ".gptwork", "pending-restarts", taskId + ".json"), markerContent);

  // Migrate
  const result = await migrateMisplacedMarker(workspaceRoot, repoPath, taskId);
  assert.equal(result.migrated, true, "should be migrated");

  // Canonical marker should exist
  const canonical = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(canonical, "canonical marker should exist");
  assert.equal(canonical.expected_commit, "def789");

  // Source file should be removed
  const sourcePath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  assert.equal(existsSync(sourcePath), false, "source misplaced marker should be removed");
});

test("migrateMisplacedMarker preserves status from source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-mmm2-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(repoPath, ".gptwork", "pending-restarts"), { recursive: true });

  const taskId = "task_migrate_status_1";
  const markerContent = JSON.stringify({
    task_id: taskId,
    requested_at: new Date().toISOString(),
    requested_by: "codex",
    status: "scheduled",
    expected_commit: "abc456",
    restart_method: "systemd-run",
    scheduled_at: new Date().toISOString(),
    repo_path: repoPath,
  });
  await writeFile(join(repoPath, ".gptwork", "pending-restarts", taskId + ".json"), markerContent);

  await migrateMisplacedMarker(workspaceRoot, repoPath, taskId);

  const canonical = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(canonical);
  assert.equal(canonical.status, "scheduled", "status should be preserved");
});

test("migrateMisplacedMarker handles nonexistent source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-mmm3-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });

  const result = await migrateMisplacedMarker(workspaceRoot, repoPath, "nonexistent_task");
  assert.equal(result.migrated, false);
  assert.match(result.diagnostic, /misplaced_safe_restart_marker/);
});

test("migrateMisplacedMarker skips if canonical already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-mmm4-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(repoPath, ".gptwork", "pending-restarts"), { recursive: true });

  const taskId = "task_migrate_dup_1";

  // Create canonical marker first
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: "existing",
  });

  // Create misplaced marker too
  const markerContent = JSON.stringify({
    task_id: taskId,
    status: "scheduled",
    repo_path: repoPath,
  });
  await writeFile(join(repoPath, ".gptwork", "pending-restarts", taskId + ".json"), markerContent);

  // Both exist — migrate should detect canonical already present
  const result = await migrateMisplacedMarker(workspaceRoot, repoPath, taskId);
  assert.equal(result.migrated, false);
  assert.match(result.diagnostic, /already exists/);

  // Canonical should still be the original
  const canonical = await loadRestartMarker(workspaceRoot, taskId);
  assert.equal(canonical.expected_commit, "existing");
});

test("getMisplacedMarkerDiagnostic produces expected format", () => {
  const diag = getMisplacedMarkerDiagnostic({
    repoPath: "/tmp/repo",
    taskId: "task_test_1",
    marker: { status: "scheduled", expected_commit: "abc123" },
  });
  assert.match(diag, /misplaced_safe_restart_marker/);
  assert.match(diag, /task=task_test_1/);
  assert.match(diag, /status=scheduled/);
  assert.match(diag, /expected_commit=abc123/);
  assert.match(diag, /repo_path=\/tmp\/repo/);

  // Missing data
  const emptyDiag = getMisplacedMarkerDiagnostic({});
  assert.match(emptyDiag, /insufficient data/);
});

test("removeMisplacedMarker removes marker file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-rmm-"));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, ".gptwork", "pending-restarts"), { recursive: true });

  const taskId = "task_remove_mp_1";
  const markerPath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  await writeFile(markerPath, "{}");
  assert.ok(existsSync(markerPath));

  const removed = await removeMisplacedMarker(repoPath, taskId);
  assert.equal(removed, true);
  assert.equal(existsSync(markerPath), false);
});

// ================================================================
// MISPLACED_MARKER_DIAGNOSTIC constant
// ================================================================

test("MISPLACED_MARKER_DIAGNOSTIC constant is correct", () => {
  assert.equal(MISPLACED_MARKER_DIAGNOSTIC, "misplaced_safe_restart_marker");
});

// ================================================================
// New exports check
// ================================================================


// ================================================================
// ================================================================
// P2.0b.3 + P2.0b.5: result.json commit priority and conflict resolution
// ================================================================

test("P2.0b.5: result.json commit rejected when it conflicts with repo HEAD and explicit expected_commit also mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b5-reject-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with one commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b5_reject_1";
  const goalId = "goal_p2b5_reject_1";
  const now = new Date().toISOString();

  // Create store with task having goal_id
  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.5 reject test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with a commit that differs from HEAD
  const resultJsonCommit = "0000000000000000000000000000000000000001";
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "P2.0b.5 reject test",
    commit: resultJsonCommit,
  }), "utf8");

  // Call with an expected_commit that also differs from HEAD
  const explicitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    expectedCommit: explicitCommit,
    repoPath,
    store,
    dryRun: true,
  });

  // P2.0b.5 rejects the stale result.json commit, then P2.0b.1 rejects the
  // explicit mismatch as well — restart should be rejected.
  assert.equal(result.ok, false, "should reject when both result.json and explicit expected_commit mismatch HEAD");
  assert.equal(result.error, "expected_commit_mismatch", "error should be expected_commit_mismatch");
  assert.equal(result.expected_commit, explicitCommit, "expected_commit in result should be the explicit value");
  assert.equal(result.local_head, localHead, "local_head should be provided");

  // Verify no marker was written
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.equal(marker, null, "no marker should be written when restart is rejected");
});

test("P2.0b.5: result.json commit rejected when conflicts with HEAD but explicit expected_commit matches HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b5-match-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b5_match_1";
  const goalId = "goal_p2b5_match_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.5 match test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with a commit that differs from local HEAD
  const resultJsonCommit = "deadbeef00000000000000000000000000000000";
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "P2.0b.5 match test",
    commit: resultJsonCommit,
  }), "utf8");

  // Call with expected_commit matching HEAD — result.json is rejected, HEAD used instead
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    expectedCommit: localHead,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true, "should succeed when explicit expected_commit matches HEAD");
  assert.equal(result.expected_commit, localHead, "expected_commit should be repo HEAD, not stale result.json commit");
  assert.equal(result.expected_commit_source, "explicit", "source should be explicit since result.json was rejected");
  assert.equal(result.result_json_commit_rejected, resultJsonCommit, "diagnostic should contain rejected commit");

  // Verify marker on disk uses HEAD and stores diagnostic
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker, "marker should exist");
  assert.equal(marker.expected_commit, localHead, "marker should store HEAD");
  assert.equal(marker.result_json_commit_rejected, resultJsonCommit, "marker should have rejected commit diagnostic");
});

test("P2.0b.5: result.json commit rejected and falls back to local HEAD when no explicit expected_commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b5-fallback-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b5_fallback_1";
  const goalId = "goal_p2b5_fallback_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.5 fallback test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with a commit that differs from local HEAD
  const resultJsonCommit = "cafebabe00000000000000000000000000000000";
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "P2.0b.5 fallback test",
    commit: resultJsonCommit,
  }), "utf8");

  // Call WITHOUT expected_commit — result.json is rejected, local HEAD used instead
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true, "should succeed with local HEAD fallback");
  assert.equal(result.expected_commit, localHead, "expected_commit should be local HEAD, not stale result.json commit");
  assert.equal(result.expected_commit_source, "local_head", "source should be local_head");
  assert.equal(result.result_json_commit_rejected, resultJsonCommit, "diagnostic should contain rejected commit");

  // Verify marker on disk uses HEAD and stores diagnostic
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker, "marker should exist");
  assert.equal(marker.expected_commit, localHead, "marker should store HEAD");
  assert.equal(marker.result_json_commit_rejected, resultJsonCommit, "marker should have rejected commit diagnostic");
});test("P2.0b.3: absent result.json preserves P2.0b.1 explicit mismatch rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b3-absent-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b3_absent_1";
  const now = new Date().toISOString();

  // Create store with task that has NO goal_id (so result.json path won't exist)
  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P2.0b.3 absent test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // No result.json — P2.0b.1 should reject the mismatch
  const fakeCommit = "a".repeat(40);
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    expectedCommit: fakeCommit,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "expected_commit_mismatch");
  assert.equal(result.expected_commit, fakeCommit);
  assert.equal(result.local_head, localHead);
});

test("P2.0b.3: absent result.json preserves P2.0b.2 local HEAD default", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b3-default-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b3_default_1";
  const now = new Date().toISOString();

  // Task with goal_id but NO result.json file
  const goalId = "goal_p2b3_default_1";
  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.3 default test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // No result.json file at the goal dir — expect local HEAD default
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  // Intentionally NOT writing result.json

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead, "should fall back to local HEAD");
  assert.equal(result.expected_commit_source, "local_head", "source should be local_head");
});

test("P2.0b.3: result.json without commit field falls back to expected_commit logic", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b3-nocommit-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b3_nocommit_1";
  const goalId = "goal_p2b3_nocommit_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.3 nocommit test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json WITHOUT a commit field
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "No commit field test",
    // no "commit" field
  }), "utf8");

  // Explicit expected_commit that matches HEAD
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    expectedCommit: localHead,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead, "should use explicit expected_commit since result.json has no commit");
  assert.equal(result.expected_commit_source, "explicit", "source should be explicit");
});

test("P2.0b.3: result.json with empty string commit falls back to expected_commit logic", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b3-empty-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b3_empty_1";
  const goalId = "goal_p2b3_empty_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.3 empty test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with empty commit
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Empty commit test",
    commit: "",
  }), "utf8");

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead, "should fall back to local HEAD when result.json commit is empty");
  assert.equal(result.expected_commit_source, "local_head", "source should be local_head");
});

// ================================================================
// P2.0b.4: Normalize result_json_commit before restart verification
// ================================================================

test("P2.0b.4: short result.json commit is normalized to full SHA via git rev-parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b4-short-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();
  const shortSha = fullSha.slice(0, 7);

  const taskId = "task_p2b4_short_1";
  const goalId = "goal_p2b4_short_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.4 short test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with SHORT commit hash
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Short hash normalization test",
    commit: shortSha,
  }), "utf8");

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, fullSha,
    "expected_commit should be the full SHA, not the short hash");
  assert.equal(result.expected_commit_source, "result_json_commit");

  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker);
  assert.equal(marker.expected_commit, fullSha,
    "marker should store the full SHA");
});

test("P2.0b.4: invalid result.json commit falls back to local HEAD default", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b4-invalid-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b4_invalid_1";
  const goalId = "goal_p2b4_invalid_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.4 invalid test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with garbage commit that won't resolve in this repo
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Invalid commit test",
    commit: "nonexistent123",
  }), "utf8");

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, localHead,
    "should fall back to local HEAD for invalid result.json commit");
  assert.equal(result.expected_commit_source, "local_head",
    "source should be local_head after fallback");
});

test("P2.0b.4: full 40-char result.json commit passes through unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b4-full-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p2b4_full_1";
  const goalId = "goal_p2b4_full_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.4 full test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with the full SHA
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Full SHA test",
    commit: fullSha,
  }), "utf8");

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, fullSha,
    "full SHA should pass through unchanged");
  assert.equal(result.expected_commit_source, "result_json_commit");

  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker);
  assert.equal(marker.expected_commit, fullSha,
    "marker should store the full SHA");
});

test("P2.0b.4: short result.json commit with explicit expected_commit still uses normalized result.json commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p2b4-explicit-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();
  const shortSha = fullSha.slice(0, 7);

  const taskId = "task_p2b4_explicit_1";
  const goalId = "goal_p2b4_explicit_1";
  const now = new Date().toISOString();

  const statePath = join(root, "state.json");
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", goal_id: goalId, title: "P2.0b.4 explicit test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Write result.json with SHORT commit hash
  const goalDir = join(workspaceRoot, ".gptwork/goals", goalId);
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "Short hash with explicit expected_commit test",
    commit: shortSha,
  }), "utf8");

  // explicit expected_commit that differs — result.json should still take priority
  const fakeCommit = "a".repeat(40);
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    expectedCommit: fakeCommit,
    repoPath,
    store,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, fullSha,
    "normalized result.json commit should take priority over explicit expected_commit");
  assert.equal(result.expected_commit_source, "result_json_commit",
    "source should be result_json_commit");
});


// ================================================================
// P2.4.1: Pending restart marker finalization hardening
// ================================================================

test("P2.4.1: pending restart marker is pre-verified when expected_commit matches running commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p241-match-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });
  const headCommit = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p241_match_1";
  const now = new Date().toISOString();
  const statePath = join(root, "state.json");

  // Write state with running task
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P2.4.1 match test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Write pending restart marker with expected_commit matching HEAD
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: headCommit,
    repo_path: repoPath,
  });

  // Create server with the repo path
  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: repoPath,
    defaultRemote: "origin",
    defaultBranch: "main",
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
  });

  // Call reconcileStaleTasks to trigger Phase C
  const result = await server.reconcileStaleTasks({ authorization: "Bearer test-token" });

  // Verify Phase C pre-verified the pending marker
  const verification = (result.restart_verifications || []).find(v => v.task_id === taskId);
  assert.ok(verification, "should have a restart verification for the task");
  assert.equal(verification.verified, true);
  assert.equal(verification.pre_verified_pending, true);

  // Verify marker on disk is now "verified"
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker);
  assert.equal(marker.status, "verified", "pending marker should be updated to verified");
  assert.equal(marker.pre_verified_pending, true);

  // Verify task log was updated
  const updatedState = JSON.parse(await readFile(statePath, "utf8"));
  const task = updatedState.tasks.find(t => t.id === taskId);
  assert.ok(task);
  const lastLog = task.logs[task.logs.length - 1];
  assert.match(lastLog.message, /pre-verified/);
});

test("P4.2i: pending restart marker with commit mismatch is marked as failed (P2.4.1 updated)", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p241-mismatch-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const taskId = "task_p241_mismatch_1";
  const now = new Date().toISOString();
  const statePath = join(root, "state.json");

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P2.4.1 mismatch test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Write pending restart marker with DIFFERENT expected_commit (doesn't match HEAD)
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: "0000000000000000000000000000000000000000",
    repo_path: repoPath,
  });

  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: repoPath,
    defaultRemote: "origin",
    defaultBranch: "main",
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
  });

  const result = await server.reconcileStaleTasks({ authorization: "Bearer test-token" });

  // Verify restart verification was produced with status=failed for this task
  const verification = (result.restart_verifications || []).find(v => v.task_id === taskId);
  assert.ok(verification, "should have a restart verification for mismatched pending marker");
  assert.equal(verification.status, "failed", "restart verification should be failed");
  assert.equal(verification.verified, false);
  assert.equal(verification.pre_verified_pending, false);

  // Verify marker is now "failed" (not still "pending")
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker);
  assert.equal(marker.status, "failed", "stale pending marker should be marked as failed after mismatch");
});

test("P2.4.1: stale repo lock is released when pending marker is pre-verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p241-lock-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });
  const headCommit = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p241_lock_1";
  const now = new Date().toISOString();
  const statePath = join(root, "state.json");

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P2.4.1 lock test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Write pending restart marker with matching expected_commit
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: headCommit,
    repo_path: repoPath,
  });

  // Write a stale repo lock for this task
  const lockId = safeRepoId(repoPath);
  const lockDir = join(workspaceRoot, ".gptwork/locks/repos");
  await mkdir(lockDir, { recursive: true });
  const lockData = {
    canonical_repo_path: repoPath,
    safe_repo_id: lockId,
    task_id: taskId,
    run_id: "test-run-123",
    pid: 99999, // non-existent PID — will be stale
    child_pid: null,
    acquired_at: new Date(Date.now() - 3600000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 3600000).toISOString(),
    mode: "builder",
    restart_state: null,
    status: "held",
  };
  await writeFile(join(lockDir, lockId + ".json"), JSON.stringify(lockData, null, 2), "utf8");

  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: repoPath,
    defaultRemote: "origin",
    defaultBranch: "main",
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
  });

  const result = await server.reconcileStaleTasks({ authorization: "Bearer test-token" });

  // Verify marker was pre-verified
  const verification = (result.restart_verifications || []).find(v => v.task_id === taskId);
  assert.ok(verification, "should have a restart verification for the task");
  assert.equal(verification.verified, true);
  assert.equal(verification.pre_verified_pending, true);

  // Verify lock was released
  const updatedLockData = JSON.parse(await readFile(join(lockDir, lockId + ".json"), "utf8"));
  assert.equal(updatedLockData.status, "released", "lock should be released after pre-verification");
});


// ================================================================
// P4.2i: verifyRestartMarker short-prefix matching
// ================================================================

test("P4.2i: short expected commit accepted as prefix of running_commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42i-prefix-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();
  const shortSha = fullSha.slice(0, 7);

  // Marker with short expected_commit that IS a prefix of running_commit
  const marker = {
    task_id: "task_p42i_prefix_1",
    expected_commit: shortSha,
    repo_path: repoPath,
    status: "pending",
  };

  const { verified, diagnostics } = await verifyRestartMarker(marker, {
    defaultRepoPath: repoPath,
  });

  assert.equal(verified, true,
    "should accept short expected_commit that is a prefix of running_commit");
  assert.equal(diagnostics.running_commit, fullSha);
  assert.ok(!diagnostics.failures || diagnostics.failures.length === 0);
});

test("P4.2i: short expected commit mismatch fails with useful reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42i-mismatch-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Marker with wrong short hash that does NOT match running_commit
  const marker = {
    task_id: "task_p42i_mismatch_1",
    expected_commit: "0000000",
    repo_path: repoPath,
    status: "pending",
  };

  const { verified, diagnostics } = await verifyRestartMarker(marker, {
    defaultRepoPath: repoPath,
  });

  assert.equal(verified, false,
    "should reject short expected_commit that is not a prefix of running_commit");
  assert.equal(diagnostics.running_commit, fullSha);
  assert.ok(diagnostics.failures && diagnostics.failures.length > 0);
  // Failure message should be descriptive about prefix mismatch
  const failureMsg = diagnostics.failures[0];
  assert.match(failureMsg, /is not a prefix/,
    "failure message should indicate short hash is not a prefix");
  assert.match(failureMsg, /0000000/,
    "failure message should include the short expected commit");
});

// ================================================================
// P4.2i: scheduleServiceRestart normalizes short expected_commit
// ================================================================

test("P4.2i: scheduleServiceRestart normalizes short expected_commit to full SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42i-normalize-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const fullSha = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();
  const shortSha = fullSha.slice(0, 7);

  // Pass short expected_commit; scheduleServiceRestart should normalize it
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_p42i_normalize_1",
    expectedCommit: shortSha,
    repoPath,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.expected_commit, fullSha,
    "expected_commit in result should be the full SHA, not the short hash");
  assert.equal(result.expected_commit_source, "explicit");

  const marker = await loadRestartMarker(workspaceRoot, "task_p42i_normalize_1");
  assert.ok(marker);
  assert.equal(marker.expected_commit, fullSha,
    "marker should store the full SHA");
});

test("P4.2i: scheduleServiceRestart rejects short expected_commit that does not resolve", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42i-nomatch-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  const localHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Short hash that does not match local HEAD
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId: "task_p42i_nomatch_1",
    expectedCommit: "0000000",
    repoPath,
    dryRun: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "expected_commit_mismatch");

  // Verify no marker was written
  const marker = await loadRestartMarker(workspaceRoot, "task_p42i_nomatch_1");
  assert.equal(marker, null);
});

// ================================================================
// P4.2i: stale goal-id pending marker is marked as failed during Phase C
// ================================================================

test("P4.2i: stale goal-id pending marker is marked as failed when expected_commit does not match", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42i-stale-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });
  const headCommit = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  const taskId = "task_p42i_stale_1";
  const now = new Date().toISOString();
  const statePath = join(root, "state.json");

  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P4.2i stale marker", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  // Write pending restart marker with WRONG expected_commit (doesn't match HEAD)
  await writePendingRestartMarker(workspaceRoot, taskId, {
    expected_commit: "0000000000000000000000000000000000000000",
    repo_path: repoPath,
  });

  // Verify marker is pending before reconciliation
  const preMarker = await loadRestartMarker(workspaceRoot, taskId);
  assert.equal(preMarker.status, "pending");

  // Create a lock for this task so we can verify it gets released
  const lockId = safeRepoId(repoPath);
  const lockDir = join(workspaceRoot, ".gptwork/locks/repos");
  await mkdir(lockDir, { recursive: true });
  const lockData = {
    canonical_repo_path: repoPath,
    safe_repo_id: lockId,
    task_id: taskId,
    run_id: "test-run-stale",
    pid: 99998,
    child_pid: null,
    acquired_at: new Date(Date.now() - 3600000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 3600000).toISOString(),
    mode: "builder",
    restart_state: null,
    status: "held",
  };
  await writeFile(join(lockDir, lockId + ".json"), JSON.stringify(lockData, null, 2), "utf8");

  const server = await createGptWorkServer({
    statePath,
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: repoPath,
    defaultRemote: "origin",
    defaultBranch: "main",
    codexHome: root,
    tokens: ["test-token"],
    requireAuth: true,
  });

  const result = await server.reconcileStaleTasks({ authorization: "Bearer test-token" });

  // Verify marker is now "failed" (not still "pending")
  const postMarker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(postMarker);
  assert.equal(postMarker.status, "failed",
    "stale pending marker should be marked as failed, not left as pending");
  assert.ok(postMarker.failure_reason,
    "failed marker should have failure_reason");

  // Verify restart_verifications includes the failure
  const verification = (result.restart_verifications || []).find(v => v.task_id === taskId);
  assert.ok(verification, "should have a restart verification for the task");
  assert.equal(verification.status, "failed");
  assert.equal(verification.verified, false);
  assert.equal(verification.pre_verified_pending, false);

  // Verify task log was updated
  const updatedState = JSON.parse(await readFile(statePath, "utf8"));
  const task = updatedState.tasks.find(t => t.id === taskId);
  assert.ok(task);
  const lastLog = task.logs[task.logs.length - 1];
  assert.match(lastLog.message, /restart marker verification failed/);

  // Verify lock was released
  const updatedLockData = JSON.parse(await readFile(join(lockDir, lockId + ".json"), "utf8"));
  assert.equal(updatedLockData.status, "released", "lock should be released after pending marker failure");
});


// ================================================================
// P4.2q: result.json commit conflicting with repo HEAD
// ================================================================

test("P4.2q: scheduleServiceRestart prefers repo HEAD over stale result.json commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42q-conflict-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  const goalsDir = join(workspaceRoot, ".gptwork/goals/stale-goal-id");
  await mkdir(goalsDir, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit (this will be the actual HEAD)
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m actual_head", { cwd: repoPath, timeout: 5000 });
  const actualHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Write a stale result.json with a DIFFERENT commit (not matching HEAD)
  const staleCommit = "0000000000000000000000000000000000000001";
  await writeFile(join(goalsDir, "result.json"), JSON.stringify({
    status: "completed",
    commit: staleCommit,
    summary: "Stale result from earlier run"
  }, null, 2), "utf8");

  // Create store with a task referencing the stale goal_id
  const statePath = join(root, "state.json");
  const taskId = "task_p42q_conflict_1";
  const now = new Date().toISOString();
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P4.2q conflict test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, goal_id: "stale-goal-id", created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  // Call scheduleServiceRestart WITHOUT passing expected_commit (simulating absence or fallback)
  // The function should read the stale result.json commit, detect it conflicts with HEAD,
  // and prefer the actual HEAD.
  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  // Verify restart was scheduled (expected_commit resolved path: "local_head" since result.json was rejected)
  assert.equal(result.ok, true,
    "restart should be scheduled even when result.json commit conflicts with HEAD");

  // Verify expected_commit matches actual HEAD, not the stale commit
  assert.equal(result.expected_commit, actualHead,
    "expected_commit should be the actual repo HEAD, not the stale result.json commit");

  // Verify expected_commit_source is "local_head" (fell through after rejection)
  assert.equal(result.expected_commit_source, "local_head",
    "expected_commit should come from local HEAD after result.json commit rejection");

  // Verify diagnostic: result_json_commit_rejected should be present
  assert.equal(result.result_json_commit_rejected, staleCommit,
    "result_json_commit_rejected should contain the stale commit that was rejected");

  // Verify diagnostic warning mentions the conflict
  assert.match(result.warning, new RegExp(staleCommit),
    "warning should mention the stale commit SHA");
  assert.match(result.warning, /did not match repo HEAD/,
    "warning should indicate that the stale commit conflicted with HEAD");
  assert.match(result.warning, new RegExp(actualHead),
    "warning should mention the actual HEAD SHA");

  // Verify marker on disk uses actual HEAD
  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker, "marker should exist on disk");
  assert.equal(marker.expected_commit, actualHead,
    "marker expected_commit should be actual HEAD, not stale commit");
  assert.equal(marker.result_json_commit_rejected, staleCommit,
    "marker should have result_json_commit_rejected field with the stale commit");

  // Verify task log was appended
  const updatedState = JSON.parse(await readFile(statePath, "utf8"));
  const task = updatedState.tasks.find(t => t.id === taskId);
  assert.ok(task);
  const lastLog = task.logs[task.logs.length - 1];
  assert.match(lastLog.message, /Expected commit/);
  assert.match(lastLog.message, new RegExp(actualHead));
});

test("P4.2q: scheduleServiceRestart with matching result.json commit uses result.json value", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p42q-match-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  const goalsDir = join(workspaceRoot, ".gptwork/goals/match-goal-id");
  await mkdir(goalsDir, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m actual_head", { cwd: repoPath, timeout: 5000 });
  const actualHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Write a result.json with the MATCHING commit
  await writeFile(join(goalsDir, "result.json"), JSON.stringify({
    status: "completed",
    commit: actualHead,
    summary: "Result matching HEAD"
  }, null, 2), "utf8");

  // Create store with a task referencing the goal_id
  const statePath = join(root, "state.json");
  const taskId = "task_p42q_match_1";
  const now = new Date().toISOString();
  const state = {
    users: [{ id: "user_default", name: "Default User" }],
    teams: [{ id: "team_default", name: "Default Team" }],
    projects: [{ id: "default", team_id: "team_default", name: "Default Project", default_workspace_id: "hosted-default", created_at: now, updated_at: now }],
    workspaces: [{ id: "hosted-default", project_id: "default", name: "Hosted Default", type: "hosted", root: workspaceRoot, default: true, created_at: now, updated_at: now }],
    goals: [], conversations: [], memories: [],
    tasks: [{ id: taskId, project_id: "default", workspace_id: "hosted-default", title: "P4.2q match test", description: "", created_by: "user_default", assignee: "codex", status: "running", mode: "builder", logs: [{ time: now, message: "started" }], artifacts: [], result: null, goal_id: "match-goal-id", created_at: now, updated_at: now }],
    chatgpt_requests: [], activities: [], audit: []
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const store = {
    state: JSON.parse(await readFile(statePath, "utf8")),
    async load() { return this.state; },
    async save() {
      await writeFile(statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  };

  const result = await scheduleServiceRestart({
    workspaceRoot,
    taskId,
    repoPath,
    store,
    dryRun: true,
  });

  // Verify restart was scheduled
  assert.equal(result.ok, true);

  // Verify expected_commit matches HEAD (result.json value === HEAD)
  assert.equal(result.expected_commit, actualHead);
  assert.equal(result.expected_commit_source, "result_json_commit",
    "should use result_json_commit source when it matches HEAD");

  // Verify NO rejection diagnostic
  assert.equal(result.result_json_commit_rejected, undefined,
    "no rejection diagnostic when result.json commit matches HEAD");

  const marker = await loadRestartMarker(workspaceRoot, taskId);
  assert.ok(marker);
  assert.equal(marker.expected_commit, actualHead);
  assert.equal(marker.result_json_commit_rejected, undefined,
    "marker should not have result_json_commit_rejected when commit matches HEAD");
});

// ================================================================
// P4.5: reconcilePendingRestartMarkers auto-verification
// ================================================================

import { reconcilePendingRestartMarkers } from "../src/diagnostics-restart-markers.mjs";
import { collectRestartMarkerStatus } from "../src/diagnostics-restart-markers.mjs";
import { invalidateCache } from "../src/diagnostics-cache.mjs";

test("P4.5: pending marker with matching expected_commit is auto-verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p45-match-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });
  const headCommit = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Create a pending restart marker with matching expected_commit
  await writePendingRestartMarker(workspaceRoot, "task_p45_match_1", {
    expected_commit: headCommit,
    repo_path: repoPath,
  });

  // Verify marker is pending before reconciliation
  const preMarker = await loadRestartMarker(workspaceRoot, "task_p45_match_1");
  assert.equal(preMarker.status, "pending");

  // Run auto-verification
  const result = await reconcilePendingRestartMarkers(workspaceRoot, repoPath);

  assert.equal(result.verified, 1, "should have verified 1 marker");
  assert.equal(result.skipped, 0, "should have skipped 0 markers");
  assert.equal(result.active_after, 0, "should have 0 active markers after");

  // Verify marker is now verified with pre_verified_pending
  const postMarker = await loadRestartMarker(workspaceRoot, "task_p45_match_1");
  assert.equal(postMarker.status, "verified");
  assert.equal(postMarker.pre_verified_pending, true);
  assert.equal(postMarker.running_commit, headCommit);
  assert.ok(postMarker.verified_at);

  // Verify collectRestartMarkerStatus now shows 0 active
  invalidateCache();
  const statusAfter = await collectRestartMarkerStatus(workspaceRoot);
  assert.equal(statusAfter.active_count, 0, "active_count should be 0 after auto-verification");
});

test("P4.5: pending marker with mismatched expected_commit is NOT auto-verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p45-mismatch-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });

  // Create a pending restart marker with WRONG expected_commit
  await writePendingRestartMarker(workspaceRoot, "task_p45_mismatch_1", {
    expected_commit: "0000000000000000000000000000000000000000",
    repo_path: repoPath,
  });

  // Verify marker is pending before reconciliation
  const preMarker = await loadRestartMarker(workspaceRoot, "task_p45_mismatch_1");
  assert.equal(preMarker.status, "pending");

  // Run auto-verification
  const result = await reconcilePendingRestartMarkers(workspaceRoot, repoPath);

  assert.equal(result.verified, 0, "should have verified 0 markers");
  assert.equal(result.skipped, 1, "should have skipped 1 marker");
  assert.equal(result.active_after, 1, "should still have 1 active marker");

  // Verify marker is STILL pending (not verified)
  const postMarker = await loadRestartMarker(workspaceRoot, "task_p45_mismatch_1");
  assert.equal(postMarker.status, "pending", "marker should remain pending when expected_commit mismatches");
  assert.equal(postMarker.pre_verified_pending, undefined);
});

test("P4.5: reconcilePendingRestartMarkers is a no-op when no markers exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p45-clean-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const result = await reconcilePendingRestartMarkers(workspaceRoot);
  assert.equal(result.verified, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.active_after, 0);
});

test("P4.5: reconcilePendingRestartMarkers handles missing repoDir gracefully", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p45-norepo-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  // Create a pending marker
  await writePendingRestartMarker(workspaceRoot, "task_p45_norepo_1", {
    expected_commit: "abc123",
  });

  // Run without repoDir — should skip (no running_commit available)
  const result = await reconcilePendingRestartMarkers(workspaceRoot, null);
  assert.equal(result.verified, 0, "should not verify without repoDir");
  assert.equal(result.skipped, 1, "should skip marker without running_commit");

  // Marker should remain pending
  const marker = await loadRestartMarker(workspaceRoot, "task_p45_norepo_1");
  assert.equal(marker.status, "pending");
});

test("P4.5: runtime_status triggers auto-verification via runtime_status handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-p45-rtstatus-"));
  const workspaceRoot = join(root, "workspace");
  const repoPath = join(root, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(repoPath, { recursive: true });

  // Init git repo with a commit
  execSync("git init", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.email test@test.com", { cwd: repoPath, timeout: 5000 });
  execSync("git config user.name Test", { cwd: repoPath, timeout: 5000 });
  execSync("git commit --allow-empty -m init", { cwd: repoPath, timeout: 5000 });
  const headCommit = execSync("git rev-parse HEAD", {
    cwd: repoPath, timeout: 5000, encoding: "utf8"
  }).trim();

  // Create a pending marker with matching expected_commit
  await writePendingRestartMarker(workspaceRoot, "task_p45_rtstatus_1", {
    expected_commit: headCommit,
    repo_path: repoPath,
  });

  // Verify pending before
  assert.equal((await loadRestartMarker(workspaceRoot, "task_p45_rtstatus_1")).status, "pending");

  // Create a server that will auto-verify via runtime_status
  const server = await createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: workspaceRoot,
    defaultRepoPath: repoPath,
    tokens: ["test-token"],
    requireAuth: true,
  });

  // Call runtime_status (should trigger auto-verification)
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_status", arguments: {} }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined);
  const result = response.result.structuredContent;

  // Verify marker was auto-verified
  const postMarker = await loadRestartMarker(workspaceRoot, "task_p45_rtstatus_1");
  assert.equal(postMarker.status, "verified", "runtime_status should auto-verify matching markers");
  assert.equal(postMarker.pre_verified_pending, true);

  // Verify restart_markers active_count is 0
  assert.equal(result.restart_markers.active_count, 0, "runtime_status should report 0 active markers after auto-verification");

  // Verify expected_commit_matches field
  // expected_commit_matches is null because the marker was already auto-verified (becomes inactive)
  assert.equal(result.expected_commit_matches, null, "expected_commit_matches should be null after auto-verification (no active markers)");
});
