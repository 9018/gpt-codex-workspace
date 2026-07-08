import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createClaudeTuiToolsGroup } from "../src/tool-groups/claude-tui-tools-group.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function fakeTool(descriptor) {
  if (typeof descriptor === "object") {
    return {
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      handler: descriptor.handler,
      metadata: {
        modes: descriptor.modes || [],
        audience: descriptor.audience || [],
        tags: descriptor.tags || [],
      },
    };
  }
  return { description: descriptor, inputSchema: descriptorSchema, handler: descriptorHandler };
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

async function makeGitRepo(prefix = "claude-tui-tools-repo-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeState(repo) {
  return {
    tasks: [{ id: "task_1", title: "Claude TUI test", goal_id: "goal_1", mode: "builder", logs: [], artifacts: [] }],
    goals: [{ id: "goal_1", task_id: "task_1", title: "Claude TUI goal" }],
    workspaces: [{ id: "hosted-default", type: "hosted", root: repo }],
  };
}

test("Claude TUI tools are registered with correct names", () => {
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore({ tasks: [], goals: [], workspaces: [] }),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo" },
  });

  const expected = [
    "claude_tui_start_goal",
    "claude_tui_status",
    "claude_tui_read",
    "claude_tui_send",
    "claude_tui_resume",
    "claude_tui_stop",
    "claude_tui_collect",
  ];

  for (const name of expected) {
    assert.equal(typeof tools[name]?.handler, "function", `${name} should be registered`);
  }
});

test("claude_tui_start_goal rejects when disabled", async () => {
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState("/tmp/repo")),
    config: { defaultWorkspaceRoot: "/tmp/gptwork", defaultRepoPath: "/tmp/repo", claudeTuiEnabled: false },
  });

  const result = await tools.claude_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "claude_tui_disabled");
  assert.equal(result.status, "disabled");
});

test("claude_tui_start_goal refuses a dirty canonical repo", async () => {
  const repo = await makeGitRepo();
  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, claudeTuiEnabled: true },
  });

  const result = await tools.claude_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "claude_tui_dirty_worktree");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.dirty_paths, ["dirty.txt"]);
});

test("claude_tui_start_goal refuses an active conflicting repo lock", async () => {
  const repo = await makeGitRepo();
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, claudeTuiEnabled: true },
    acquireRepoLockFn: async () => ({ acquired: false, heldByTask: "other_task", reason: "Repo lock held by task other_task" }),
  });

  const result = await tools.claude_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "claude_tui_repo_locked");
  assert.equal(result.status, "blocked");
  assert.equal(result.held_by_task, "other_task");
});

test("claude_tui_start_goal acquires lock and starts a session", async () => {
  const repo = await makeGitRepo();
  const calls = [];
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, claudeTuiEnabled: true },
    acquireRepoLockFn: async (workspaceRoot, repoPath, opts) => {
      calls.push({ name: "lock", workspaceRoot, repoPath, opts });
      return { acquired: true, lock: { safe_repo_id: "repo_1", task_id: opts.taskId, status: "held" } };
    },
    startGoalSessionFn: async ({ task, goal, cwd, repoLockId }) => {
      calls.push({ name: "start", task, goal, cwd, repoLockId });
      return { id: "session_1", task_id: task.id, goal_id: goal.id, cwd, status: "running" };
    },
    getSessionStatusFn: async (sessionId) => ({ id: sessionId, status: "running" }),
    readSessionFn: async (sessionId, opts) => ({ id: sessionId, task_id: "task_1", cwd: repo, log: "logged", maxChars: opts.maxChars }),
    sendSessionInputFn: async (sessionId, text) => ({ id: sessionId, log: `[input] ${text}` }),
    resumeSessionFn: async (sessionId) => ({ id: sessionId, status: "running", restart_count: 1 }),
    stopSessionFn: async (sessionId, opts) => ({ id: sessionId, status: "stopped", reason: opts.reason }),
    collectCompletionFn: async ({ sessionId }) => ({ kind: "claude_tui_completion_snapshot", session_id: sessionId }),
  });

  const started = await tools.claude_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(started.session_id, "session_1");
  assert.equal(started.task_id, "task_1");
  assert.equal(started.goal_id, "goal_1");
  assert.equal(started.cwd, repo);
  assert.equal(started.status, "running");
  assert.equal(calls[0].name, "lock");
  assert.equal(calls[1].name, "start");
});

test("Claude TUI tools delegate to session functions correctly", async () => {
  const repo = await makeGitRepo();
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, claudeTuiEnabled: true },
    acquireRepoLockFn: async () => ({ acquired: true, lock: { safe_repo_id: "repo_1", task_id: "task_1", status: "held" } }),
    startGoalSessionFn: async ({ task, goal, cwd }) => ({ id: "session_1", task_id: task.id, goal_id: goal.id, cwd, status: "running" }),
    getSessionStatusFn: async (sessionId) => ({ id: sessionId, status: "running" }),
    readSessionFn: async (sessionId) => ({ id: sessionId, log: "Claude TUI log output" }),
    sendSessionInputFn: async (sessionId, text) => ({ id: sessionId, log: `[input] ${text}` }),
    resumeSessionFn: async (sessionId) => ({ id: sessionId, status: "running", restart_count: 1 }),
    stopSessionFn: async (sessionId, opts) => ({ id: sessionId, status: "stopped", reason: opts.reason }),
    collectCompletionFn: async ({ sessionId }) => ({ kind: "claude_tui_completion_snapshot", session_id: sessionId }),
  });

  assert.deepEqual(await tools.claude_tui_status.handler({ session_id: "s1" }), { id: "s1", status: "running" });
  assert.deepEqual(await tools.claude_tui_read.handler({ session_id: "s1", max_chars: 100 }), { id: "s1", log: "Claude TUI log output" });
  assert.deepEqual(await tools.claude_tui_send.handler({ session_id: "s1", text: "continue\n" }), { id: "s1", log: "[input] continue\n" });
  assert.deepEqual(await tools.claude_tui_resume.handler({ session_id: "s1" }), { id: "s1", status: "running", restart_count: 1 });
  assert.deepEqual(await tools.claude_tui_collect.handler({ session_id: "s1" }), { kind: "claude_tui_completion_snapshot", session_id: "s1" });
});

test("claude_tui_stop releases repo lock after stopping", async () => {
  const repo = await makeGitRepo();
  let lockReleased = false;
  const tools = createClaudeTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, claudeTuiEnabled: true },
    readSessionFn: async () => ({ id: "s1", cwd: repo, task_id: "task_1", log: "" }),
    stopSessionFn: async (sessionId, opts) => ({ id: sessionId, status: "stopped", reason: opts.reason }),
    releaseRepoLockFn: async (ws, cwd, taskId) => { lockReleased = true; },
  });

  await tools.claude_tui_stop.handler({ session_id: "s1" });
  assert.equal(lockReleased, true);
});
