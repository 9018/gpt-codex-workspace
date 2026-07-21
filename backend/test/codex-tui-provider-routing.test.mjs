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
    materializeTaskWorktreeFn: async () => {
      const worktreePath = join(root, ".gptwork", "worktrees", "task_1");
      await mkdir(worktreePath, { recursive: true });
      return {
        task_worktree_path: worktreePath,
        lock_repo_path: worktreePath,
        worktree_lifecycle: { ok: true, mode: "git_worktree", worktree_path: worktreePath },
      };
    },
    verifyTaskWorktreeFn: async () => ({ valid: true, source: "test-fixture" }),
    resolvePathContextFn: async ({ task }) => {
      const projectRoot = task.canonical_repo_path || root;
      const executionCwd = task.task_worktree_path || projectRoot;
      const codexHome = join(projectRoot, ".codex-runtime");
      return {
        mcpRoot: root,
        projectsRoot: root,
        workspaceRoot: root,
        projectRoot,
        canonicalRepoPath: projectRoot,
        executionCwd,
        worktreePath: task.task_worktree_path || null,
        codexHome,
        nativeSessionsRoot: join(codexHome, "sessions"),
        controlSessionsRoot: join(projectRoot, ".gptwork", "codex-sessions"),
        codexHomeMode: "project",
      };
    },
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

test("missing provider metadata defaults to autonomous codex TUI", async () => {
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
    startCodexTuiGoalSessionFn: async (args) => {
      tuiCalled = true;
      return { id: "session_default_tui", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" };
    },
    runCodexTuiEvidenceCycleFn: async () => ({
      evidence_ready: true,
      session_id: "session_default_tui",
      collected: {
        result_json: {
          status: "completed",
          summary: "default TUI completed",
          changed_files: [],
          tests: "none",
          commit: "none",
          verification: { passed: true, commands: [] },
          operation_kind: "diagnostic",
          integration_not_required: true,
        },
        changed_files: [],
        tests: "none",
        commit: "none",
        result_md_present: true,
        worktree_clean: true,
        findings: [],
      },
    }),
  }));

  assert.equal(execCalled, false);
  assert.equal(tuiCalled, true);
  assert.equal(result.status, "completed");
});

test("general processor uses the unified dispatcher without parking a healthy TUI run for review", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-unified-dispatcher-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  const statuses = [];
  let dispatchInput = null;
  const deps = baseDeps(root, {
    updateTaskFn: async (currentStore, taskId, updater) => {
      const currentTask = currentStore.state.tasks.find((item) => item.id === taskId);
      updater(currentTask);
      statuses.push(currentTask.status);
      return { task: currentTask };
    },
    taskProviderDispatcherFn: async (input) => {
      dispatchInput = input;
      return {
        status: "completed",
        provider: "codex_tui",
        attempt: {
          id: "attempt_unified_tui",
          state: "completed",
          provider: "codex_tui",
          provider_handle: { session_id: "session_unified_tui", native_session_id: "native_unified_tui" },
        },
        evidence: {
          status: "completed",
          summary: "unified TUI completed",
          changed_files: [],
          tests: [],
          commit: null,
          verification: { passed: true, commands: [] },
          raw: { operation_kind: "diagnostic", integration_not_required: true },
        },
      };
    },
    resolvePathContextFn: async ({ task }) => ({
      workspace_root: root,
      canonical_repo_path: root,
      task_worktree_path: task.task_worktree_path,
      execution_cwd: task.task_worktree_path,
      codex_home: join(root, ".codex"),
    }),
    startCodexTuiGoalSessionFn: async (args) => ({
      id: "legacy_session_must_not_start",
      cwd: args.cwd,
      status: "running",
    }),
  });

  const result = await processGeneralTaskWithDeps(
    store,
    { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true },
    store.state.tasks[0],
    {},
    {},
    deps,
  );

  assert.equal(dispatchInput.task.id, "task_1");
  assert.equal(dispatchInput.executionCwd, join(root, ".gptwork", "worktrees", "task_1"));
  assert.equal(result.status, "completed");
  assert.equal(statuses.includes("waiting_for_review"), false);
});

test("codex_tui_goal missing evidence schedules automatic recovery without invoking codex exec", async () => {
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
  assert.equal(tuiArgs.cwd, join(root, ".gptwork", "worktrees", "task_1"));
  assert.equal(result.status, "waiting_for_review");
  assert.equal(result.result.session_id, "session_1");
  assert.equal(store.state.tasks[0].status, "waiting_for_review");
  assert.equal(store.state.tasks[0].result.provider, "codex_tui");
  assert.equal(store.state.tasks[0].result.commit, "none");
  assert.deepEqual(store.state.tasks[0].result.changed_files, []);
  assert.equal(store.state.tasks[0].result.tests, null);
});

test("worker does not start or materialize when a manual TUI owner already claimed the task", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-manual-owner-")));
  const store = makeStore(root, {
    status: "running",
    metadata: {
      codex_execution_provider: "codex_tui_goal",
      tui_session_owner: "manual",
      manual_tui_session_starting: true,
    },
  });
  let materialized = false;
  let started = false;

  const result = await processGeneralTaskWithDeps(
    store,
    { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true },
    store.state.tasks[0],
    {},
    {},
    baseDeps(root, {
      materializeTaskWorktreeFn: async () => { materialized = true; throw new Error("must not materialize"); },
      startCodexTuiGoalSessionFn: async () => { started = true; throw new Error("must not start"); },
    }),
  );

  assert.equal(result.kind, "codex_tui_owned_by_manual");
  assert.equal(result.status, "running");
  assert.equal(materialized, false);
  assert.equal(started, false);
  assert.equal(store.state.tasks[0].metadata.tui_session_owner, "manual");
  assert.equal(store.state.tasks[0].status, "running");
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

test("codex_tui_goal missing result.json enters human review without retry or repair", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-missing-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });


  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: true }, store.state.tasks[0], {}, {}, baseDeps(root, {
    startCodexTuiGoalSessionFn: async (args) => ({ id: "session_missing", task_id: args.task.id, goal_id: args.goal.id, cwd: args.cwd, status: "running" }),
  }));

  assert.equal(result.status, "waiting_for_review");
  assert.equal(result.result.session_id, "session_missing");
  assert.equal(store.state.tasks[0].status, "waiting_for_review");
  assert.equal(store.state.tasks[0].result.session_id, "session_missing");
  assert.equal(store.state.tasks[0].result.tui_phase, "human_review_missing_evidence");
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

test("codex_tui_goal when TUI disabled does not auto-fallback to exec", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-route-disabled-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  let execCalled = false;
  let tuiCalled = false;

  const result = await processGeneralTaskWithDeps(store, { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true, codexTuiEnabled: false }, store.state.tasks[0], {}, {}, baseDeps(root, {
    executeCodexTaskRunFn: async () => {
      execCalled = true;
      return {
        cr: { returncode: 0, stdout: "", stderr: "", timed_out: false },
        parsedResult: {
          structured: true,
          status: "completed",
          summary: "exec availability fallback completed",
          changed_files: [],
          tests: { passed: 1, failed: 0 },
          commit: "none",
        },
        summary: "exec availability fallback completed",
        codexMeta: { provider: "codex_exec" },
      };
    },
    startCodexTuiGoalSessionFn: async () => { tuiCalled = true; throw new Error("TUI should not start"); },
  }));

  assert.equal(execCalled, false);
  assert.equal(tuiCalled, false);
  assert.equal(result.status, "waiting_for_supervisor");
  // No exec fallback was done, so there is no summary
  assert.equal(result.summary, undefined);
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

test("codex_exec provider responses 404 blocks and does not enter acceptance or integration", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-provider-404-")));
  await mkdir(join(root, ".gptwork", "worktrees", "task_1"), { recursive: true });
  const store = makeStore(root);
  const stderr = "ERROR unexpected status 404 Not Found: not found, url: http://www.9017i.cc:58901/v1/responses";
  let acceptanceCalls = 0;
  let integrationCalls = 0;
  let finalized = null;

  const result = await processGeneralTaskWithDeps(
    store,
    { defaultWorkspaceRoot: root, defaultRepoPath: root, enableTaskWorktrees: true },
    store.state.tasks[0],
    {},
    {},
    baseDeps(root, {
      executeCodexTaskRunFn: async () => ({
        cr: { returncode: 1, stdout: "", stderr, timed_out: false },
        parsedResult: { status: null, summary: null, changed_files: [], structured: false, from_json: false },
        summary: stderr,
      }),
      runAcceptanceAgentFn: async () => {
        acceptanceCalls += 1;
        throw new Error("acceptance must not run for a provider endpoint blocker");
      },
      runIntegrationQueueFn: async () => {
        integrationCalls += 1;
        throw new Error("integration must not run for a provider endpoint blocker");
      },
      finalizeCodexTaskRunFn: async (args) => {
        finalized = args;
        return { task_id: args.task.id, status: args.taskStatus, result: args.taskResult };
      },
    }),
  );

  assert.equal(result.status, "waiting_for_review");
  assert.equal(acceptanceCalls, 0);
  assert.equal(integrationCalls, 0);
  assert.equal(finalized.taskResult.failure_class, "codex_transport_404");
  assert.equal(finalized.taskResult.pipeline_halted, true);
  assert.equal(finalized.taskResult.acceptance_findings[0].code, "provider_endpoint_not_found");
  assert.match(finalized.taskResult.next_action, /provider endpoint/i);
});

test("TUI evidence timeout stops the live session and enters human review without retry or repair", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "codex-tui-timeout-retry-")));
  const store = makeStore(root, { metadata: { codex_execution_provider: "codex_tui_goal" } });
  let stopped = null;
  let released = 0;
  let sessionReleaseLock = null;

  const result = await processGeneralTaskWithDeps(
    store,
    {
      defaultWorkspaceRoot: root,
      defaultRepoPath: root,
      enableTaskWorktrees: true,
      codexTuiEnabled: true,
      codexTuiEvidenceWaitMs: 5,
    },
    store.state.tasks[0],
    {},
    {},
    baseDeps(root, {
      startCodexTuiGoalSessionFn: async (args) => {
        sessionReleaseLock = args.releaseLockFn;
        return {
          id: "session_timeout",
          task_id: args.task.id,
          goal_id: args.goal.id,
          cwd: args.cwd,
          status: "running",
        };
      },
      runCodexTuiEvidenceCycleFn: async () => ({
        evidence_ready: false,
        status: "timed_out",
        reason: "tui_result_json_timeout",
        finding: { severity: "blocker", code: "tui_result_json_timeout", message: "result.json timed out" },
      }),
      stopCodexTuiSessionFn: async (sessionId, options) => {
        stopped = { sessionId, options };
        await sessionReleaseLock?.();
        return { id: sessionId, status: "stopped" };
      },
      releaseLockForTaskFn: async () => { released += 1; },
    }),
  );

  assert.equal(stopped?.sessionId, "session_timeout");
  assert.equal(stopped?.options?.reason, "evidence_timeout");
  assert.equal(released, 1);
  assert.equal(store.state.tasks[0].status, "waiting_for_review");
  assert.equal(store.state.tasks[0].result.failure_class, undefined);
  assert.equal(store.state.tasks[0].result.requires_human_review, true);
  assert.equal(store.state.tasks[0].result.retry_original_task, false);
  assert.equal(store.state.tasks[0].result.create_repair_task, false);
  assert.equal(store.state.tasks[0].result.verification.passed, null);
  assert.equal(store.state.tasks[0].result.verification.indeterminate, true);
  assert.equal(store.state.tasks[0].metadata.tui_session_owner, undefined);
  assert.equal(store.state.tasks[0].metadata.tui_session_id, "session_timeout");
  assert.equal(result.status, "waiting_for_review");
  assert.equal(result.kind, "codex_tui_awaiting_human_review");
  assert.equal(result.create_repair_task, false);
});
