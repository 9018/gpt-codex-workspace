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
    runCodexTuiEvidenceCycleFn: async ({ sessionId }) => ({
      evidence_ready: false,
      reason: "tui_result_json_missing",
      status: "not_ready",
      session_id: sessionId,
      goal_id: "goal_1",
      task_id: "task_1",
      expected_result_json: join(root, ".gptwork", "goals", "goal_1", "result.json"),
      finding: {
        severity: "major",
        code: "tui_result_json_missing",
        message: "Missing durable result file",
      },
      collected: { result_json_present: false },
    }),
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
  assert.equal(result.kind, "codex_tui_awaiting_evidence");
  assert.equal(result.session_id, "session_1");
  assert.equal(store.state.tasks[0].result.provider, "codex_tui_goal");
  assert.equal(store.state.tasks[0].result.commit, "none");
  assert.deepEqual(store.state.tasks[0].result.changed_files, []);
  assert.equal(store.state.tasks[0].result.tests, null);
});

test("codex_tui_goal ready evidence enters acceptance integration finalizer path", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-ready-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  const calls = [];

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => { throw new Error("codex exec should not run"); },
    startCodexTuiGoalSessionFn: async (args) => ({ id: "session_ready", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" }),
    runCodexTuiEvidenceCycleFn: async () => ({
      evidence_ready: true,
      reason: "tui_result_json_collected",
      session_id: "session_ready",
      goal_id: "goal_1",
      task_id: "task_1",
      collected: {
        result_json: {
          status: "completed",
          summary: "TUI completed with durable evidence",
          changed_files: ["backend/src/feature.mjs"],
          tests: "node --test backend/test/feature.test.mjs",
          commit: "abc1234",
          verification: { passed: true, commands: [{ cmd: "node --test backend/test/feature.test.mjs", exit_code: 0, passed: true }] },
        },
        changed_files: ["backend/src/feature.mjs"],
        tests: "node --test backend/test/feature.test.mjs",
        commit: "abc1234",
        result_md_present: true,
        worktree_clean: true,
        findings: [],
      },
    }),
    runAcceptanceAgentFn: async ({ result: acceptedResult }) => {
      calls.push({ type: "acceptance", result: acceptedResult });
      return {
        passed: true,
        status: "accepted",
        profile: "code_change",
        findings: [],
        repair_proposals: [],
        next_tasks: [],
        evidence: { changed_files: ["backend/src/feature.mjs"] },
        reviewer_decision: { role: "acceptance_agent", summary: "accepted", decision: { status: "accepted", passed: true } },
      };
    },
    runIntegrationQueueFn: async () => {
      calls.push({ type: "integration" });
      return { ok: true, status: "completed", commit: "abc1234", merged: true };
    },
    finalizeCodexTaskRunFn: async ({ taskStatus, taskResult, autoStartNextOnTaskCompletedFn }) => {
      assert.equal(typeof autoStartNextOnTaskCompletedFn, "function");
      calls.push({ type: "finalize", taskStatus, taskResult });
      return { task_id: "task_1", status: taskStatus, result: taskResult };
    },
    autoStartNextOnTaskCompletedFn: async () => {
      calls.push({ type: "auto_start" });
      return { started: false };
    },
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.type), ["acceptance", "integration", "finalize"]);
  const finalized = calls.find((call) => call.type === "finalize").taskResult;
  assert.equal(finalized.provider, "codex_tui_goal");
  assert.equal(finalized.execution_backend, "codex_tui_superpowers");
  assert.equal(finalized.session_id, "session_ready");
  assert.equal(finalized.tui_phase, "evidence_ready");
  assert.equal(finalized.commit, "abc1234");
  assert.deepEqual(finalized.changed_files, ["backend/src/feature.mjs"]);
  assert.equal(finalized.verification.passed, true);
  assert.equal(finalized.integration.status, "completed");
});

test("codex_tui_goal missing result.json terminates as failed with actionable evidence", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-missing-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });


  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    startCodexTuiGoalSessionFn: async (args) => ({ id: "session_missing", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" }),
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.session_id, "session_missing");
  assert.equal(store.state.tasks[0].status, "failed");
  assert.equal(store.state.tasks[0].result.session_id, "session_missing");
  assert.equal(store.state.tasks[0].result.tui_phase, "blocked_missing_evidence");
  assert.equal(store.state.tasks[0].result.collect_result.status, "not_ready");
  assert.match(store.state.tasks[0].result.collect_result.expected_result_json, /goal_1\/result\.json$/);
  assert.equal(store.state.tasks[0].result.collect_result.finding.code, "tui_result_json_missing");
});

test("codex_tui_goal dirty ready evidence becomes a blocker instead of closing", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-dirty-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  let finalized = null;

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    startCodexTuiGoalSessionFn: async (args) => ({ id: "session_dirty", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" }),
    runCodexTuiEvidenceCycleFn: async () => ({
      evidence_ready: true,
      session_id: "session_dirty",
      goal_id: "goal_1",
      task_id: "task_1",
      collected: {
        result_json: {
          status: "completed",
          summary: "TUI produced a result but left a dirty worktree",
          changed_files: ["backend/src/dirty.mjs"],
          tests: "node --test backend/test/dirty.test.mjs",
          commit: "abc1234",
          verification: { passed: true, commands: [{ cmd: "node --test backend/test/dirty.test.mjs", exit_code: 0, passed: true }] },
        },
        changed_files: ["backend/src/dirty.mjs"],
        tests: "node --test backend/test/dirty.test.mjs",
        commit: "abc1234",
        result_md_present: true,
        worktree_clean: false,
        findings: [{ severity: "blocker", code: "dirty_worktree", message: "The TUI worktree has uncommitted changes." }],
      },
    }),
    runAcceptanceAgentFn: async () => ({
      passed: false,
      status: "needs_review",
      profile: "code_change",
      findings: [{ severity: "blocker", code: "dirty_worktree", message: "The TUI worktree has uncommitted changes." }],
      repair_proposals: [],
      next_tasks: [],
      evidence: { changed_files: ["backend/src/dirty.mjs"] },
      reviewer_decision: { role: "acceptance_agent", summary: "blocked", decision: { status: "needs_review", passed: false } },
    }),
    convergeTaskAfterRunFn: () => ({ nextStatus: "waiting_for_review", findings: [], profile: "code_change", repairPlan: {}, reason: "dirty_worktree" }),
    finalizeCodexTaskRunFn: async ({ taskStatus, taskResult }) => {
      finalized = { taskStatus, taskResult };
      return { task_id: "task_1", status: taskStatus, result: taskResult };
    },
  }));

  assert.equal(result.status, "waiting_for_review");
  assert.equal(finalized.taskStatus, "waiting_for_review");
  assert.ok(finalized.taskResult.acceptance_findings.some((finding) => finding.code === "dirty_worktree"));
  assert.equal(finalized.taskResult.verification.passed, false);
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
