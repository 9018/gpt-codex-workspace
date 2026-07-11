import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCodexTuiToolsGroup } from "../src/tool-groups/codex-tui-tools-group.mjs";
import { createTools } from "../src/server-tools.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function fakeTool(descriptorOrDescription, inputSchema, handler) {
  if (typeof descriptorOrDescription === "object") {
    return {
      description: descriptorOrDescription.description,
      inputSchema: descriptorOrDescription.inputSchema,
      handler: descriptorOrDescription.handler,
      metadata: {
        modes: descriptorOrDescription.modes || [],
        audience: descriptorOrDescription.audience || [],
        tags: descriptorOrDescription.tags || [],
      },
    };
  }
  return { description: descriptorOrDescription, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

function makeStore(state) {
  return {
    state,
    async load() { return state; },
    async save() {},
    async findTaskById(taskId) { return state.tasks.find((task) => task.id === taskId) || null; },
  };
}

async function makeGitRepo(prefix = "codex-tui-tools-repo-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeState(repo, taskId = "task_1", goalId = "goal_1") {
  return {
    tasks: [{ id: taskId, title: "Manual TUI", goal_id: goalId, mode: "builder", logs: [], artifacts: [] }],
    goals: [{ id: goalId, task_id: taskId, title: "Manual TUI goal" }],
    workspaces: [{ id: "hosted-default", type: "hosted", root: repo }],
  };
}

test("codex TUI tools are registered and discoverable through server tools", () => {
  const tools = createTools({
    store: makeStore({ tasks: [], goals: [], workspaces: [] }),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo" },
    browser: {}, github: {}, bark: {}, envLoadResult: {}, sources: {}, registry: null, workerState: {}, processStartedAt: Date.now(),
  });

  for (const name of [
    "codex_tui_start_goal",
    "codex_tui_status",
    "codex_tui_read",
    "codex_tui_send",
    "codex_tui_stop",
    "codex_tui_collect",
  ]) {
    assert.equal(typeof tools[name]?.handler, "function", `${name} should be registered`);
  }
});

test("codex_tui_start_goal rejects when disabled", async () => {
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState("/tmp/repo")),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo", codexTuiEnabled: false },
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "codex_tui_disabled");
  assert.equal(result.status, "disabled");
});

test("codex_tui_start_goal refuses a task already claimed by the worker", async () => {
  const state = makeState("/tmp/repo", "task_worker_owned", "goal_worker_owned");
  state.tasks[0].status = "running";
  state.tasks[0].metadata = {
    codex_execution_provider: "codex_tui_goal",
    tui_session_owner: "worker",
    worker_tui_session_starting: true,
  };
  let materialized = false;
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(state),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo", codexTuiEnabled: true },
    materializeTaskWorktreeFn: async () => { materialized = true; throw new Error("must not materialize"); },
  });

  await assert.rejects(
    tools.codex_tui_start_goal.handler({ task_id: "task_worker_owned" }, {}),
    (err) => err?.code === "codex_tui_task_already_claimed" && /worker/.test(err.message),
  );
  assert.equal(materialized, false);
  assert.equal(state.tasks[0].metadata.tui_session_owner, "worker");
});

test("codex_tui_start_goal refuses a dirty task worktree", async () => {
  const repo = await makeGitRepo();
  const taskId = "task_dirty_wt";

  // Create a real worktree first, then make it dirty
  const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  const wt = await ensureTaskWorktree("default", taskId, {
    workspaceRoot: repo,
    canonicalRepoPath: repo,
    baseRef: "HEAD",
  });
  assert.equal(wt.ok, true);

  // Make the worktree dirty
  await writeFile(join(wt.worktree_path, "dirty.txt"), "dirty\n");

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, "goal_dirty_wt")),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    resolveTaskRepositoryPlanFn: async ({ task }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "default",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        base_ref: "HEAD",
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "default", task.id),
        dirty_source: false,
        dirty_paths: [],
      };
    },
    materializeTaskWorktreeFn: async (plan) => {
      return {
        worktree_lifecycle: {
          ok: true,
          mode: "git_worktree",
          source_root: repo,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: "gptwork/task/" + plan.task_id,
          worktree_path: plan.task_worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: null,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async () => ({ acquired: true, lock: { safe_repo_id: "safe" } }),
    startCodexTuiGoalSessionFn: async ({ cwd }) => ({ id: "session_dirty", cwd, status: "running" }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});
  assert.equal(result.kind, "codex_tui_dirty_worktree");
  assert.equal(result.status, "blocked");
  assert.ok(result.dirty_paths.length > 0, "should report dirty paths");
  assert.ok(result.dirty_paths.includes("dirty.txt"), "should include dirty.txt");
});

test("codex_tui_start_goal refuses an active conflicting worktree lock", async () => {
  const repo = await makeGitRepo();
  const taskId = "task_locked_wt";

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, "goal_locked_wt")),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    resolveTaskRepositoryPlanFn: async ({ task }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "default",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        base_ref: "HEAD",
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "default", task.id),
        dirty_source: false,
        dirty_paths: [],
      };
    },
    materializeTaskWorktreeFn: async (plan) => {
      const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
      const result = await ensureTaskWorktree("default", plan.task_id, {
        workspaceRoot: repo,
        canonicalRepoPath: repo,
        baseRef: "HEAD",
      });
      return {
        worktree_lifecycle: {
          ok: result.ok,
          mode: "git_worktree",
          source_root: repo,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: result.branch_name,
          worktree_path: result.worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: result.ok ? null : result.error,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async () => ({ acquired: false, heldByTask: "other_task", reason: "Worktree lock held by task other_task" }),
    startCodexTuiGoalSessionFn: async ({ cwd }) => ({ id: "session_locked", cwd, status: "running" }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});
  assert.equal(result.kind, "codex_tui_worktree_locked");
  assert.equal(result.status, "blocked");
  assert.equal(result.held_by_task, "other_task");
});

test("codex_tui_start_goal acquires lock on worktree, starts a session, and delegates status/read/send/stop", async () => {
  const repo = await makeGitRepo();
  const taskId = "task_wt_session";

  const calls = [];
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, "goal_wt_session")),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    resolveTaskRepositoryPlanFn: async ({ task }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "default",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        base_ref: "HEAD",
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "default", task.id),
        dirty_source: false,
        dirty_paths: [],
      };
    },
    materializeTaskWorktreeFn: async (plan) => {
      const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
      const result = await ensureTaskWorktree("default", plan.task_id, {
        workspaceRoot: repo,
        canonicalRepoPath: repo,
        baseRef: "HEAD",
      });
      calls.push({ name: "materialize", plan, result });
      return {
        worktree_lifecycle: {
          ok: result.ok,
          mode: "git_worktree",
          source_root: repo,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: result.branch_name,
          worktree_path: result.worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: result.ok ? null : result.error,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async (workspaceRoot, repoPath, opts) => {
      calls.push({ name: "lock", workspaceRoot, repoPath, opts });
      return { acquired: true, lock: { safe_repo_id: "repo_1", task_id: opts.taskId, status: "held" } };
    },
    startCodexTuiGoalSessionFn: async ({ task, goal, cwd, repoLockId }) => {
      calls.push({ name: "start", task, goal, cwd, repoLockId });
      return { id: "session_wt_" + task.id, task_id: task.id, goal_id: goal.id, cwd, status: "running" };
    },
    getCodexTuiSessionStatusFn: async (sessionId) => ({ id: sessionId, status: "running" }),
    readCodexTuiSessionFn: async (sessionId, opts) => ({ id: sessionId, task_id: taskId, cwd: "worktree_cwd", log: "hello", maxChars: opts.maxChars }),
    sendCodexTuiSessionInputFn: async (sessionId, text) => ({ id: sessionId, log: `[input] ${text}` }),
    stopCodexTuiSessionFn: async (sessionId, opts) => ({ id: sessionId, status: "stopped", reason: opts.reason }),
  });

  const started = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});
  assert.equal(started.session_id, "session_wt_" + taskId);
  assert.equal(started.task_id, taskId);
  assert.equal(started.goal_id, "goal_wt_session");
  // cwd must be the worktree path, not the canonical repo
  assert.notEqual(started.cwd, repo, "cwd must be the worktree path, not canonical repo");
  assert.ok(started.cwd.includes(".gptwork/worktrees"), "cwd must be under .gptwork/worktrees");
  assert.equal(started.status, "running");
  // Should have called materialize -> lock -> start
  assert.equal(calls[0].name, "materialize");
  assert.equal(calls[1].name, "lock");
  assert.equal(calls[2].name, "start");

  assert.deepEqual(await tools.codex_tui_status.handler({ session_id: "session_1" }), { id: "session_1", status: "running" });
  assert.deepEqual(await tools.codex_tui_read.handler({ session_id: "session_1", max_chars: 5 }), { id: "session_1", task_id: taskId, cwd: "worktree_cwd", log: "hello", maxChars: 5 });
  assert.deepEqual(await tools.codex_tui_send.handler({ session_id: "session_1", text: "continue\n" }), { id: "session_1", log: "[input] continue\n" });
  assert.deepEqual(await tools.codex_tui_stop.handler({ session_id: "session_1" }), { id: "session_1", status: "stopped", reason: "manual_stop" });

  // Clean up worktree
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "default", canonicalRepoPath: repo });
});

test("codex_tui_collect delegates to the completion collector", async () => {
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore({ tasks: [], goals: [] }),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo", codexTuiEnabled: true },
    collectCodexTuiCompletionFn: async ({ sessionId }) => ({ kind: "codex_tui_completion_snapshot", session_id: sessionId }),
  });

  const result = await tools.codex_tui_collect.handler({ session_id: "session_1" });
  assert.deepEqual(result, { kind: "codex_tui_completion_snapshot", session_id: "session_1" });
});

// ===========================================================================
// G2: Worktree-based execution — codex_tui_start_goal uses task_worktree_path
// ===========================================================================

test("G2: codex_tui_start_goal materializes worktree and uses it as cwd", async () => {
  const repo = track(await makeGitRepo("g2-wt-cwd-"));
  const taskId = "task_g2_wt";
  const goalId = "goal_g2_wt";

  const materializedPaths = [];
  let lockAcquiredOn = null;

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, goalId)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    findTaskFn: async (st, id) => {
      const s = await st.load();
      const t = s.tasks.find(t => t.id === id);
      if (!t) throw new Error(`task not found: ${id}`);
      return t;
    },
    resolveTaskRepositoryPlanFn: async ({ task }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "test-repo",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        base_ref: "HEAD",
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "test-repo", task.id),
        dirty_source: false,
        dirty_paths: [],
      };
    },
    materializeTaskWorktreeFn: async (plan) => {
      const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
      const result = await ensureTaskWorktree(plan.repo_id, plan.task_id, {
        workspaceRoot: repo,
        canonicalRepoPath: repo,
        baseRef: "HEAD",
      });
      materializedPaths.push(result.worktree_path);
      return {
        worktree_lifecycle: {
          ok: result.ok,
          mode: "git_worktree",
          source_root: repo,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: result.branch_name,
          worktree_path: result.worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: result.ok ? null : result.error,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async (wsRoot, rp, opts) => {
      lockAcquiredOn = rp;
      return { acquired: true, lock: { safe_repo_id: "safe_repo", task_id: opts.taskId, status: "held" } };
    },
    startCodexTuiGoalSessionFn: async ({ cwd }) => ({ id: "session_g2_wt", cwd, status: "running" }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});

  // Must succeed
  assert.equal(result.kind, "codex_tui_session_started");
  assert.equal(result.status, "running");

  // cwd must be worktree path, NOT canonical repo
  assert.notEqual(result.cwd, repo, "cwd must not be canonical repo");
  assert.ok(result.cwd.includes(".gptwork/worktrees"), "cwd must be under worktrees");
  assert.equal(result.cwd, result.worktree_path, "cwd must equal worktree_path");

  // Lock on worktree path
  assert.equal(lockAcquiredOn, result.cwd, "lock must be on worktree path");

  // Verify it's a real git worktree
  const gitCheck = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: result.cwd, encoding: "utf8",
  }).trim();
  assert.equal(gitCheck, "true", "worktree must be a valid git worktree");

  // Canonical repo must still be clean
  const canonicalStatus = execFileSync("git", ["status", "--short"], {
    cwd: repo, encoding: "utf8",
  }).trim();
  assert.equal(canonicalStatus, "", "canonical repo must remain clean");

  // Clean up
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "test-repo", canonicalRepoPath: repo });
});

test("G2: codex_tui_start_goal returns worktree metadata in response", async () => {
  const repo = track(await makeGitRepo("g2-meta-"));
  const taskId = "task_g2_meta";
  const goalId = "goal_g2_meta";

  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo, taskId, goalId)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    findTaskFn: async (st, id) => {
      const s = await st.load();
      const t = s.tasks.find(t => t.id === id);
      if (!t) throw new Error(`task not found: ${id}`);
      return t;
    },
    resolveTaskRepositoryPlanFn: async ({ task }) => {
      const { getTaskWorktreePath, sanitizeTaskBranchName } = await import("../src/task-worktree-manager.mjs");
      return {
        repo_id: "test-repo",
        canonical_repo_path: repo,
        source_root: repo,
        task_id: task.id,
        base_ref: "HEAD",
        task_branch: sanitizeTaskBranchName(task.id),
        task_worktree_path: getTaskWorktreePath(repo, "test-repo", task.id),
        dirty_source: false,
        dirty_paths: [],
      };
    },
    materializeTaskWorktreeFn: async (plan) => {
      const { ensureTaskWorktree } = await import("../src/task-worktree-manager.mjs");
      const result = await ensureTaskWorktree(plan.repo_id, plan.task_id, {
        workspaceRoot: repo, canonicalRepoPath: repo, baseRef: "HEAD",
      });
      return {
        worktree_lifecycle: {
          ok: result.ok,
          mode: "git_worktree",
          source_root: repo,
          base_ref: "HEAD",
          base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
          branch_name: result.branch_name,
          worktree_path: result.worktree_path,
          dirty_source: false,
          dirty_paths: [],
          created_at: new Date().toISOString(),
          error: result.ok ? null : result.error,
          lifecycle_events: [],
        },
      };
    },
    acquireRepoLockFn: async () => ({ acquired: true, lock: { safe_repo_id: "safe" } }),
    startCodexTuiGoalSessionFn: async ({ cwd }) => ({ id: "session_g2_meta", cwd, status: "running" }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: taskId }, {});

  // Response must include worktree metadata
  assert.ok(result.worktree_path, "response must include worktree_path");
  assert.ok(result.canonical_repo_path, "response must include canonical_repo_path");
  assert.ok(result.branch, "response must include branch");
  assert.ok(result.execution_id, "response must include execution_id");
  assert.equal(result.canonical_repo_path, repo);
  assert.equal(result.branch, "gptwork/task/task_g2_meta");

  // Clean up
  const { removeTaskWorktree } = await import("../src/task-worktree-manager.mjs");
  await removeTaskWorktree(taskId, { workspaceRoot: repo, repoId: "test-repo", canonicalRepoPath: repo });
});
