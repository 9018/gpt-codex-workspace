import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCodexTuiToolsGroup } from "../src/tool-groups/codex-tui-tools-group.mjs";
import { createCodexTuiPtyAdapter, createCodexTuiUnavailableError } from "../src/codex-tui-pty-adapter.mjs";

function tool(d) { return d; }
function schema(shape = {}, required = []) { return { type: "object", properties: shape, required }; }
function storeFor(state) {
  return {
    state,
    async load() { return state; },
    async save(next) { if (next) this.state = next; },
    async findTaskById(id) { return state.tasks.find((t) => t.id === id) || null; },
  };
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "tui-chain-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  return root;
}

test("codex adapter uses script fallback by default when node-pty is unavailable", async () => {
  const calls = [];
  const child = {
    pid: 123,
    stdout: { on() {} }, stderr: { on() {} },
    stdin: { write() {}, end() {} }, kill() {},
  };
  const adapter = createCodexTuiPtyAdapter({
    loadPty: async () => { throw createCodexTuiUnavailableError(); },
    spawnImpl(command, args, options) { calls.push({ command, args, options }); return child; },
  });
  const session = await adapter.spawn({ cwd: "/repo" });
  assert.equal(session.adapter, "script");
  assert.equal(calls[0].command, "script");
});

test("manual TUI start persists provider metadata and releases lock on spawn failure", async () => {
  const root = await repo();
  const task = { id: "task_fail", title: "fail", goal_id: "goal_fail", mode: "builder", metadata: {} };
  const state = { tasks: [task], goals: [{ id: "goal_fail", task_id: task.id }], workspaces: [] };
  const store = storeFor(state);
  let released = null;
  let executionPatch = null;
  const worktree = join(root, "wt");
  execFileSync("git", ["worktree", "add", "-b", "gptwork/task/task_fail", worktree, "HEAD"], { cwd: root, stdio: "ignore" });

  const tools = createCodexTuiToolsGroup({
    tool, schema, store,
    config: { defaultWorkspaceRoot: root, defaultRepoPath: root, codexTuiEnabled: true },
    resolveTaskRepositoryPlanFn: async () => ({ canonical_repo_path: root, source_root: root, base_ref: "HEAD", task_worktree_path: worktree, task_branch: "gptwork/task/task_fail" }),
    materializeTaskWorktreeFn: async () => ({ worktree_lifecycle: { ok: true, worktree_path: worktree, branch_name: "gptwork/task/task_fail" } }),
    acquireRepoLockFn: async () => ({ acquired: true, lock: { safe_repo_id: "lock_1" } }),
    releaseRepoLockFn: async (...args) => { released = args; },
    createExecutionStoreFn: () => ({
      async createExecution(value) { return { id: "exec_1", ...value }; },
      async updateExecution(id, patch) { executionPatch = { id, patch }; },
    }),
    startCodexTuiGoalSessionFn: async () => { const e = new Error("PTY unavailable"); e.code = "codex_tui_unavailable"; throw e; },
  });

  const result = await tools.codex_tui_start_goal.handler({ task_id: task.id }, {});
  assert.equal(result.kind, "codex_tui_start_failed");
  assert.equal(result.status, "failed");
  assert.equal(task.metadata.codex_execution_provider, "codex_tui_goal");
  assert.ok(released, "repo lock must be released");
  assert.equal(executionPatch.patch.status, "failed");
});
