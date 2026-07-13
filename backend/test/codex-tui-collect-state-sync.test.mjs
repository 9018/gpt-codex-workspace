/**
 * codex-tui-collect-state-sync.test.mjs — Tests for TUI collect auto-state-sync
 *
 * TDD: These tests MUST fail first (before the fix) because
 * codex_tui_collect currently returns a snapshot but does not write back
 * to the task or transition its status from running to waiting_for_review.
 *
 * After the fix, complete clean evidence will:
 * - Transition task.status from running → waiting_for_review
 * - Write provider/session_id/commit/tests/changed_files/verification to task.result
 * - Clear tui_session_owner but preserve session_id in metadata
 * - NOT transition when snapshot is dirty/blocked
 * - Be idempotent on repeated calls
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCodexTuiToolsGroup } from "../src/tool-groups/codex-tui-tools-group.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function fakeTool(descriptorOrDescription, inputSchema, handler) {
  if (typeof descriptorOrDescription === "object") {
    return {
      description: descriptorOrDescription.description,
      inputSchema: descriptorOrDescription.inputSchema,
      handler: descriptorOrDescription.handler,
      metadata: { modes: descriptorOrDescription.modes || [], audience: descriptorOrDescription.audience || [], tags: descriptorOrDescription.tags || [] },
    };
  }
  return { description: descriptorOrDescription, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

async function makeGitRepo(prefix = "codex-tui-sync-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

/**
 * Create a controlled test setup with:
 * - A real git repo
 * - A task in "running" state with TUI session metadata
 * - A session record
 * - Goal directory with result.md and result.json
 */
async function setupCompleteEvidence({ repo, taskId, goalId, sessionId, commit } = {}) {
  // Create task state
  const state = {
    tasks: [{
      id: taskId || "task_sync",
      goal_id: goalId || "goal_sync",
      title: "TUI sync test",
      status: "running",
      mode: "builder",
      metadata: {
        codex_execution_provider: "codex_tui_goal",
        tui_session_owner: "manual",
        tui_session_id: sessionId || "session_sync",
      },
      result: { provider: "codex_tui_goal", session_id: sessionId || "session_sync" },
      logs: [],
      artifacts: [],
    }],
    goals: [{ id: goalId || "goal_sync", task_id: taskId || "task_sync", title: "TUI sync goal" }],
  };

  const store = {
    _state: state,
    async load() { return this._state; },
    async save() {},
    async findTaskById(taskId) { return this._state.tasks.find((t) => t.id === taskId) || null; },
    findGoalByTaskId(taskId) { return this._state.goals.find((g) => g.task_id === taskId) || null; },
  };

  // Create session record
  const sessionStore = createCodexTuiSessionStore({ workspaceRoot: repo });
  await sessionStore.createSession({
    sessionId: sessionId || "session_sync",
    taskId: taskId || "task_sync",
    goalId: goalId || "goal_sync",
    cwd: repo,
    repoLockId: "lock_1",
    metadata: { commit: commit || null },
  });

  // Create goal artifacts
  const goalDir = join(repo, ".gptwork", "goals", goalId || "goal_sync");
  await mkdir(goalDir, { recursive: true });

  return { repo, state, store, goalDir, sessionStore };
}

// ===========================================================================
// Failing test A1: Complete evidence → state transitions to waiting_for_review
// ===========================================================================

test("A1: TUI collect transitions task from running to waiting_for_review when evidence is complete", async () => {
  const repo = await makeGitRepo();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const { store, goalDir } = await setupCompleteEvidence({ repo });

  // Create complete evidence
  await writeFile(join(goalDir, "result.md"), `Summary: TUI session completed.\n\nTests: npm test\nCommit: ${commit}\n`);
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "TUI session completed",
    changed_files: [],
    tests: [{ command: "npm test", status: "passed" }],
    verification: { passed: true },
    commit,
  }));

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  const snapshot = await tools.codex_tui_collect.handler({ session_id: "session_sync" });

  // Snapshot should indicate ready_for_review
  assert.equal(snapshot.ready_for_review, true, "snapshot should be ready for review");
  assert.equal(snapshot.worktree_clean, true, "worktree should be clean");
  assert.deepEqual(snapshot.findings, [], "no findings for complete evidence");

  // STORM: This fails currently — the task stays 'running'.
  // After fix: task.status should be 'waiting_for_review'
  const updatedTask = await store.findTaskById("task_sync");
  assert.equal(updatedTask.status, "waiting_for_review",
    "task transitions from running to waiting_for_review after complete TUI collect");

  // Verify result fields are written back
  assert.equal(updatedTask.result.provider, "codex_tui_goal", "provider written to task result");
  assert.equal(updatedTask.result.session_id, "session_sync", "session_id preserved in task result");
  assert.equal(updatedTask.result.commit, commit, "commit written to task result");
  assert.ok(updatedTask.result.tests || updatedTask.result.verification, "tests or verification written to task result");
  assert.deepEqual(updatedTask.result.changed_files, [], "changed_files written to task result");
  assert.equal(updatedTask.result.verification?.passed, true, "verification passed written to task result");

  // session_owner cleared, but session_id remains in metadata
  if (updatedTask.metadata) {
    assert.equal(updatedTask.metadata.tui_session_owner, undefined,
      "tui_session_owner cleared after collect");
    assert.equal(updatedTask.metadata.tui_session_id, "session_sync",
      "tui_session_id preserved in metadata");
  }

  // Logs should have entry
  const logEntry = (updatedTask.logs || []).find((l) => l.message && l.message.includes("collect") && l.message.includes("waiting_for_review"));
  assert.ok(logEntry, "task log should contain collect transition entry");
});

// ===========================================================================
// Failing test A2: Incomplete evidence → NO state transition
// ===========================================================================

test("A2: TUI collect does NOT transition when snapshot is dirty/blocked", async () => {
  const repo = await makeGitRepo();
  const { store, goalDir } = await setupCompleteEvidence({ repo });

  // Create result.md but keep dirty worktree (uncommitted change)
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), "Summary: incomplete.\n");
  // Make a dirty change in the repo
  await writeFile(join(repo, "dirty.txt"), "uncommitted\n");

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  const snapshot = await tools.codex_tui_collect.handler({ session_id: "session_sync" });

  // Snapshot should NOT be ready
  assert.equal(snapshot.ready_for_review, false, "snapshot not ready with dirty worktree");
  assert.equal(snapshot.worktree_clean, false, "worktree should be dirty");
  assert.ok(snapshot.findings.length > 0, "findings should exist for dirty state");

  // Task should remain running
  const task = await store.findTaskById("task_sync");
  assert.equal(task.status, "running",
    "task remains running when snapshot is not ready_for_review");
});

// ===========================================================================
// Failing test A3: No result.md → NO state transition (blocked)
// ===========================================================================

test("A3: TUI collect does NOT transition when result.md is missing", async () => {
  const repo = await makeGitRepo();
  const { store } = await setupCompleteEvidence({ repo });

  // Do NOT create any evidence files

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  const snapshot = await tools.codex_tui_collect.handler({ session_id: "session_sync" });

  assert.equal(snapshot.ready_for_review, false, "snapshot not ready without result.md");
  assert.equal(snapshot.result_md_present, false, "result.md not present");

  // Task should remain running
  const task = await store.findTaskById("task_sync");
  assert.equal(task.status, "running",
    "task remains running when result.md is missing");
});

// ===========================================================================
// Failing test A4: Collector state writeback is idempotent
// ===========================================================================

test("A4: Repeated TUI collect is idempotent and does not corrupt state", async () => {
  const repo = await makeGitRepo();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const { store, goalDir } = await setupCompleteEvidence({ repo });

  // Create complete evidence
  await writeFile(join(goalDir, "result.md"), `Summary: TUI session completed.\n\nTests: npm test\nCommit: ${commit}\n`);
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed", summary: "TUI session completed",
    changed_files: [], tests: [{ command: "npm test", status: "passed" }],
    verification: { passed: true }, commit,
  }));

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  // First collect
  const snap1 = await tools.codex_tui_collect.handler({ session_id: "session_sync" });
  assert.equal(snap1.ready_for_review, true, "first collect ready");

  // Second collect — should be idempotent
  const snap2 = await tools.codex_tui_collect.handler({ session_id: "session_sync" });
  assert.equal(snap2.ready_for_review, true, "second collect also ready");

  const task = await store.findTaskById("task_sync");
  assert.equal(task.status, "waiting_for_review", "status stays waiting_for_review after second collect");

  // Verify result fields haven't been corrupted
  assert.equal(task.result.provider, "codex_tui_goal");
  assert.equal(task.result.session_id, "session_sync");
  assert.equal(task.result.commit, commit);
  assert.equal(task.result.verification?.passed, true);
});

// ===========================================================================
// Failing test A5: Assigned→waiting_for_review — task in 'assigned' state
// with manual TUI ownership should also transition
// ===========================================================================

test("A5: TUI collect transitions task from assigned to waiting_for_review when evidence is complete", async () => {
  const repo = await makeGitRepo();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  // Use "assigned" status, simulating worker-skipped manual TUI session
  const state = {
    tasks: [{
      id: "task_assigned_sync",
      goal_id: "goal_assigned_sync",
      title: "TUI assigned sync test",
      status: "assigned",
      mode: "builder",
      metadata: {
        codex_execution_provider: "codex_tui_goal",
        tui_session_owner: "manual",
        tui_session_id: "session_assigned",
      },
      result: { provider: "codex_tui_goal", session_id: "session_assigned" },
      logs: [],
      artifacts: [],
    }],
    goals: [{ id: "goal_assigned_sync", task_id: "task_assigned_sync", title: "TUI assigned sync goal" }],
  };

  const store = {
    _state: state,
    async load() { return this._state; },
    async save() {},
    async findTaskById(taskId) { return this._state.tasks.find((t) => t.id === taskId) || null; },
    findGoalByTaskId(taskId) { return this._state.goals.find((g) => g.task_id === taskId) || null; },
  };

  const sessionStore = createCodexTuiSessionStore({ workspaceRoot: repo });
  await sessionStore.createSession({
    sessionId: "session_assigned",
    taskId: "task_assigned_sync",
    goalId: "goal_assigned_sync",
    cwd: repo,
    repoLockId: "lock_1",
    metadata: { commit },
  });

  const goalDir = join(repo, ".gptwork", "goals", "goal_assigned_sync");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.md"), `Summary: TUI session completed.\n\nTests: npm test\nCommit: ${commit}\n`);
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed", summary: "TUI session completed",
    changed_files: [], tests: [{ command: "npm test", status: "passed" }],
    verification: { passed: true }, commit,
  }));

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  const snapshot = await tools.codex_tui_collect.handler({ session_id: "session_assigned" });

  assert.equal(snapshot.ready_for_review, true, "snapshot should be ready for review");

  // STORM: This fails currently — task stays 'assigned'.
  const updatedTask = await store.findTaskById("task_assigned_sync");
  assert.equal(updatedTask.status, "waiting_for_review",
    "task transitions from assigned to waiting_for_review after complete TUI collect");
  assert.equal(updatedTask.result.provider, "codex_tui_goal", "provider written");
});
