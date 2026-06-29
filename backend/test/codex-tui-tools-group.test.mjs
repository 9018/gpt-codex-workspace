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
    tasks: [{ id: "task_1", title: "Manual TUI", goal_id: "goal_1", mode: "builder", logs: [], artifacts: [] }],
    goals: [{ id: "goal_1", task_id: "task_1", title: "Manual TUI goal" }],
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

test("codex_tui_start_goal refuses a dirty canonical repo", async () => {
  const repo = await makeGitRepo();
  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "codex_tui_dirty_worktree");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.dirty_paths, ["dirty.txt"]);
});

test("codex_tui_start_goal refuses an active conflicting repo lock", async () => {
  const repo = await makeGitRepo();
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    acquireRepoLockFn: async () => ({ acquired: false, heldByTask: "other_task", reason: "Repo lock held by task other_task" }),
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(result.kind, "codex_tui_repo_locked");
  assert.equal(result.status, "blocked");
  assert.equal(result.held_by_task, "other_task");
});

test("codex_tui_start_goal acquires lock, starts a session, and delegates status/read/send/stop", async () => {
  const repo = await makeGitRepo();
  const calls = [];
  const tools = createCodexTuiToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: makeStore(makeState(repo)),
    config: { defaultWorkspaceRoot: repo, defaultRepoPath: repo, codexTuiEnabled: true },
    acquireRepoLockFn: async (workspaceRoot, repoPath, opts) => {
      calls.push({ name: "lock", workspaceRoot, repoPath, opts });
      return { acquired: true, lock: { safe_repo_id: "repo_1", task_id: opts.taskId, status: "held" } };
    },
    startCodexTuiGoalSessionFn: async ({ task, goal, cwd, repoLockId }) => {
      calls.push({ name: "start", task, goal, cwd, repoLockId });
      return { id: "session_1", task_id: task.id, goal_id: goal.id, cwd, status: "running" };
    },
    getCodexTuiSessionStatusFn: async (sessionId) => ({ id: sessionId, status: "running" }),
    readCodexTuiSessionFn: async (sessionId, opts) => ({ id: sessionId, task_id: "task_1", cwd: repo, log: "hello", maxChars: opts.maxChars }),
    sendCodexTuiSessionInputFn: async (sessionId, text) => ({ id: sessionId, log: `[input] ${text}` }),
    stopCodexTuiSessionFn: async (sessionId, opts) => ({ id: sessionId, status: "stopped", reason: opts.reason }),
  });

  const started = await tools.codex_tui_start_goal.handler({ task_id: "task_1" }, {});
  assert.equal(started.session_id, "session_1");
  assert.equal(started.task_id, "task_1");
  assert.equal(started.goal_id, "goal_1");
  assert.equal(started.cwd, repo);
  assert.equal(started.status, "running");
  assert.equal(calls[0].name, "lock");
  assert.equal(calls[1].name, "start");

  assert.deepEqual(await tools.codex_tui_status.handler({ session_id: "session_1" }), { id: "session_1", status: "running" });
  assert.deepEqual(await tools.codex_tui_read.handler({ session_id: "session_1", max_chars: 5 }), { id: "session_1", task_id: "task_1", cwd: repo, log: "hello", maxChars: 5 });
  assert.deepEqual(await tools.codex_tui_send.handler({ session_id: "session_1", text: "continue\n" }), { id: "session_1", log: "[input] continue\n" });
  assert.deepEqual(await tools.codex_tui_stop.handler({ session_id: "session_1" }), { id: "session_1", status: "stopped", reason: "manual_stop" });
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
