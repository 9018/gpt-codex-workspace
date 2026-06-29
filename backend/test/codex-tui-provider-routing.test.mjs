import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processGeneralTaskWithDeps } from "../src/task-general-processor.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function makeStore(root, taskPatch = {}) {
  const now = new Date().toISOString();
  const state = {
    tasks: [{
      id: "task_1",
      project_id: "default",
      workspace_id: "hosted-default",
      goal_id: "goal_1",
      title: "Provider route",
      description: "Route provider",
      assignee: "codex",
      status: "assigned",
      mode: "builder",
      logs: [],
      artifacts: [],
      result: null,
      created_at: now,
      updated_at: now,
      ...taskPatch,
    }],
    goals: [{ id: "goal_1", task_id: "task_1", title: "Provider route goal", workspace_id: "hosted-default", mode: "builder" }],
    workspaces: [{ id: "hosted-default", type: "hosted", root }],
    activities: [],
  };
  return {
    state,
    async load() { return state; },
    async save() {},
    async findTaskById(taskId) { return state.tasks.find((task) => task.id === taskId) || null; },
  };
}

function baseDeps(root, overrides = {}) {
  return {
    updateTaskFn: async (store, taskId, updater) => {
      const task = store.state.tasks.find((item) => item.id === taskId);
      updater(task);
      return { task };
    },
    ensureTaskGoalFn: async (store, config, taskId) => ({ task: store.state.tasks.find((task) => task.id === taskId), goal: store.state.goals[0] }),
    selectWorkspaceFn: async () => ({ id: "hosted-default", type: "hosted", root }),
    resolveTaskRepositoryPlanFn: async () => ({ repo_id: "default", canonical_repo_path: root, task_worktree_path: join(root, ".gptwork", "worktrees", "task_1") }),
    materializeTaskWorktreeFn: async () => ({
      task_worktree_path: join(root, ".gptwork", "worktrees", "task_1"),
      lock_repo_path: join(root, ".gptwork", "worktrees", "task_1"),
      worktree_lifecycle: { ok: true, mode: "git_worktree", worktree_path: join(root, ".gptwork", "worktrees", "task_1") },
    }),
    acquireRepoLockFn: async () => ({ acquired: true, lock: { safe_repo_id: "default", status: "held" } }),
    appendGoalMessageFn: async () => {},
    prepareCodexTaskRunFn: async () => ({ promptFile: null, runFilePath: null, runId: "run_1" }),
    executeCodexTaskRunFn: async () => ({ cr: { returncode: 0 }, parsedResult: { structured: true, status: "completed", summary: "ok", changed_files: [], tests: "none" }, summary: "ok" }),
    finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => ({ task_id: "task_1", status: taskStatus, result: taskResult }),
    runAcceptanceAgentFn: async () => ({ passed: true, findings: [], repair_proposals: [], next_tasks: [], reviewer_decision: null }),
    convergeTaskAfterRunFn: () => ({ nextStatus: "completed", findings: [], profile: "noop", repairPlan: null, reason: null }),
    runIntegrationQueueFn: async () => ({ ok: true, status: "skipped" }),
    shouldAttemptRepairFn: async () => ({ should_repair: false, reason: "no" }),
    ...overrides,
  };
}

test("missing provider metadata still routes to codex_exec", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-exec-")));
  await mkdir(join(root, ".gptwork", "worktrees", "task_1"), { recursive: true });
  const store = makeStore(root);
  let execCalled = false;
  let tuiCalled = false;

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => {
      execCalled = true;
      return { cr: { returncode: 0 }, parsedResult: { structured: true, status: "completed", summary: "ok", changed_files: [], tests: "none" }, summary: "ok" };
    },
    startCodexTuiGoalSessionFn: async () => { tuiCalled = true; throw new Error("should not start TUI"); },
  }));

  assert.equal(execCalled, true);
  assert.equal(tuiCalled, false);
  assert.notEqual(result.kind, "codex_tui_session_started");
});

test("codex_tui_goal metadata routes to session manager and does not invoke codex exec", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-tui-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  let execCalled = false;
  let tuiArgs = null;

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => { execCalled = true; throw new Error("codex exec should not run"); },
    startCodexTuiGoalSessionFn: async (args) => {
      tuiArgs = args;
      return { id: "session_1", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" };
    },
  }));

  assert.equal(execCalled, false);
  assert.equal(tuiArgs.task.id, "task_1");
  assert.equal(tuiArgs.goal.id, "goal_1");
  assert.equal(tuiArgs.cwd, root);
  assert.equal(result.kind, "codex_tui_session_started");
  assert.equal(result.provider, "codex_tui_goal");
  assert.equal(result.session_id, "session_1");
  assert.equal(result.commit, "none");
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.tests, null);
});

test("codex_tui_goal metadata returns disabled result when TUI config is disabled", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-disabled-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  let execCalled = false;
  let tuiCalled = false;

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: false }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => { execCalled = true; throw new Error("codex exec should not run"); },
    startCodexTuiGoalSessionFn: async () => { tuiCalled = true; throw new Error("TUI should not start"); },
  }));

  assert.equal(execCalled, false);
  assert.equal(tuiCalled, false);
  assert.equal(result.kind, "codex_tui_disabled");
  assert.equal(result.provider, "codex_tui_goal");
  assert.equal(result.status, "provider_unavailable");
});

test("unknown provider metadata still routes to codex_exec", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-unknown-")));
  await mkdir(join(root, ".gptwork", "worktrees", "task_1"), { recursive: true });
  const store = makeStore(root, { metadata: { codex_execution_provider: "future_provider" } });
  let execCalled = false;

  await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => {
      execCalled = true;
      return { cr: { returncode: 0 }, parsedResult: { structured: true, status: "completed", summary: "ok", changed_files: [], tests: "none" }, summary: "ok" };
    },
  }));

  assert.equal(execCalled, true);
});
