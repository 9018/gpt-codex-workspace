import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectClaudeTuiRuntimeDiagnostics } from "../src/claude-tui-runtime-diagnostics.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { AGENT_TUI_PROVIDERS, CODEX_EXECUTION_PROVIDERS } from "../src/codex-execution-provider.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo(prefix = "claude-tui-runtime-diag-") {
  const repo = track(await mkdtemp(join(tmpdir(), prefix)));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeStore(tasks = []) {
  const state = { tasks };
  return {
    state,
    async load() { return state; },
    async save() {},
  };
}

test("omits claude TUI diagnostics when not configured and no sessions exist", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "claude-tui-runtime-empty-")));

  const diagnostics = await collectClaudeTuiRuntimeDiagnostics({
    workspaceRoot,
    store: makeStore([{ id: "task_exec", metadata: {} }]),
    config: {},
    env: {},
  });

  assert.equal(diagnostics, null);
});

test("reports explicit optional provider state", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "claude-tui-runtime-explicit-")));

  const diagnostics = await collectClaudeTuiRuntimeDiagnostics({
    workspaceRoot,
    store: makeStore([]),
    config: { claudeTuiEnabled: true },
    env: {},
  });

  assert.equal(diagnostics.provider, AGENT_TUI_PROVIDERS.CLAUDE);
  assert.equal(diagnostics.optional, true);
  assert.equal(diagnostics.activation, "explicit_only");
  assert.equal(diagnostics.default_provider, CODEX_EXECUTION_PROVIDERS.EXEC);
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.session_store.present, false);
});

test("returns provider info when sessions exist in store", async () => {
  const repo = await makeGitRepo();
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId: "goal_1_task_1",
    taskId: "task_1",
    goalId: "goal_1",
    cwd: repo,
    metadata: { provider: "claude" },
  });

  const diagnostics = await collectClaudeTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([{ id: "task_1", metadata: { codex_execution_provider: "claude_tui_goal" } }]),
    config: { claudeTuiEnabled: true },
    env: {},
  });

  assert.equal(diagnostics.provider, AGENT_TUI_PROVIDERS.CLAUDE);
  assert.equal(diagnostics.session_store.session_count, 1);
  assert.equal(diagnostics.session_store.present, true);
  assert.equal(diagnostics.sessions.length, 1);
  assert.equal(diagnostics.sessions[0].id, "goal_1_task_1");
});

test("reports no-result findings for sessions without result evidence", async () => {
  const repo = await makeGitRepo();
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId: "goal_2_task_2",
    taskId: "task_2",
    goalId: "goal_2",
    cwd: repo,
    metadata: { provider: "claude" },
  });

  const diagnostics = await collectClaudeTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([]),
    config: { claudeTuiEnabled: true },
    env: {},
  });

  assert.equal(diagnostics.session_store.session_count, 1);
  assert.equal(diagnostics.completion.no_result_count, 1);
  assert.ok(diagnostics.findings.some((f) => f.code === "claude_tui_no_result"));
});
