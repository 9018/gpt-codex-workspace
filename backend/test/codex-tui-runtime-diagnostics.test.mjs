import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectCodexTuiRuntimeDiagnostics } from "../src/codex-tui-runtime-diagnostics.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { CODEX_EXECUTION_PROVIDERS } from "../src/codex-execution-provider.mjs";
import { createRecoveryToolsGroup } from "../src/tool-groups/recovery-tools-group.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeGitRepo(prefix = "codex-tui-runtime-diag-") {
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

function fakeTool(descriptor) {
  return descriptor;
}

function fakeSchema(shape = {}, required = []) {
  return { type: "object", properties: shape, required };
}

test("omits codex_tui_goal diagnostics when TUI is not configured and no task/session references it", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-runtime-empty-")));

  const diagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot,
    store: makeStore([{ id: "task_exec", metadata: {} }]),
    config: {},
    env: {},
  });

  assert.equal(diagnostics, null);
});

test("reports autonomous TUI as the default provider", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-runtime-explicit-")));

  const diagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot,
    store: makeStore([
      { id: "task_exec", metadata: {} },
      { id: "task_tui", metadata: { codex_execution_provider: "codex_tui_goal" } },
    ]),
    config: { codexTuiEnabled: false },
    env: {},
  });

  assert.equal(diagnostics.provider, CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
  assert.equal(diagnostics.optional, false);
  assert.equal(diagnostics.activation, "default_autonomous");
  assert.equal(diagnostics.default_provider, CODEX_EXECUTION_PROVIDERS.TUI_GOAL);
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.explicit_task_count, 1);
  assert.equal(diagnostics.session_store.present, false);
  assert.ok(diagnostics.findings.some((finding) => finding.code === "codex_tui_goal_disabled"));
});

test("summarizes missing result and retained session references without leaking logs or result contents", async () => {
  const repo = await makeGitRepo();
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId: "session_1",
    taskId: "task_tui",
    goalId: "goal_1",
    cwd: repo,
    repoLockId: "repo_lock_1",
  });
  await store.updateSession("session_1", { status: "running", pty_pid: 4242 });
  await store.appendSessionLog("session_1", "SECRET_TOKEN=should-not-leak\ntranscript line should not leak");
  await mkdir(join(repo, ".gptwork", "goals", "goal_1"), { recursive: true });
  await writeFile(join(repo, ".gptwork", "goals", "goal_1", "result.md"), "Summary contains should-not-leak\nTests: npm test\n");

  const diagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([{ id: "task_tui", metadata: { codex_execution_provider: "codex_tui_goal" } }]),
    config: { codexTuiEnabled: true },
    env: {},
  });

  assert.equal(diagnostics.session_store.present, true);
  assert.equal(diagnostics.session_store.session_count, 1);
  assert.equal(diagnostics.session_store.running_count, 1);
  assert.equal(diagnostics.session_store.retained_reference_count, 1);
  assert.equal(diagnostics.completion.ready_for_review_count, 0);
  assert.equal(diagnostics.completion.no_result_count, 0);
  assert.equal(diagnostics.completion.result_missing_count, 0);
  assert.equal(diagnostics.completion.commit_missing_count, 0);
  assert.equal(diagnostics.sessions[0].id, "session_1");
  assert.equal(diagnostics.sessions[0].has_log, true);
  assert.equal(diagnostics.sessions[0].result_md_present, true);
  assert.equal(diagnostics.sessions[0].result_json_present, false);
  assert.equal(diagnostics.sessions[0].commit, null);
  assert.equal(diagnostics.sessions[0].tests_present, true);
  assert.ok(diagnostics.findings.some((finding) => finding.code === "codex_tui_result_json_missing"));

  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("should-not-leak"), false);
  assert.equal(serialized.includes("SECRET_TOKEN"), false);
  assert.equal(serialized.includes("transcript line"), false);
  assert.equal(serialized.includes("Summary contains"), false);
});

test("reports stale default-provider session references without requiring provider metadata", async () => {
  const repo = await makeGitRepo();
  const store = createCodexTuiSessionStore({ workspaceRoot: repo });
  await store.createSession({
    sessionId: "session_stale",
    taskId: "task_missing_metadata",
    goalId: "goal_2",
    cwd: join(repo, "missing-worktree"),
  });

  const diagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([{ id: "task_missing_metadata", metadata: {} }]),
    config: { codexTuiEnabled: true },
    env: {},
  });

  assert.equal(diagnostics.session_store.stale_reference_count, 1);
  assert.equal(diagnostics.completion.no_result_count, 1);
  assert.ok(diagnostics.findings.some((finding) => finding.code === "codex_tui_session_cwd_missing"));
  assert.equal(diagnostics.findings.some((finding) => finding.code === "codex_tui_provider_metadata_missing"), false);
  assert.ok(diagnostics.findings.some((finding) => finding.code === "codex_tui_no_result"));
});

test("stopped historical TUI references remain visible without elevating current health", async () => {
  const repo = await makeGitRepo("codex-tui-runtime-history-");
  const sessionStore = createCodexTuiSessionStore({ workspaceRoot: repo });
  await sessionStore.createSession({
    sessionId: "session_history",
    taskId: "task_deleted",
    goalId: "goal_history",
    cwd: join(repo, "removed-worktree"),
  });
  await sessionStore.updateSession("session_history", { status: "stopped" });

  const diagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([]),
    config: { codexTuiEnabled: true },
    env: {},
  });

  const historical = diagnostics.findings.filter((finding) => finding.historical === true);
  assert.ok(historical.some((finding) => finding.code === "codex_tui_task_missing"));
  assert.ok(historical.some((finding) => finding.code === "codex_tui_session_cwd_missing"));
  assert.ok(historical.every((finding) => finding.severity === "info"));
  assert.equal(diagnostics.highest_severity, "info");
});

test("stopped dirty TUI snapshot is historical info while active dirty snapshot remains warning", async () => {
  const repo = await makeGitRepo("codex-tui-runtime-dirty-history-");
  const sessionStore = createCodexTuiSessionStore({ workspaceRoot: repo });
  await sessionStore.createSession({
    sessionId: "session_dirty_history",
    taskId: "task_dirty_history",
    goalId: "goal_dirty_history",
    cwd: repo,
  });
  await sessionStore.updateSession("session_dirty_history", { status: "stopped" });
  await writeFile(join(repo, "README.md"), "dirty historical snapshot\n");

  const stoppedDiagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([]),
    config: { codexTuiEnabled: true },
    env: {},
  });
  const stoppedDirty = stoppedDiagnostics.findings.find((finding) => finding.code === "codex_tui_dirty_worktree");
  assert.equal(stoppedDirty.severity, "info");
  assert.equal(stoppedDirty.historical, true);
  assert.equal(stoppedDiagnostics.highest_severity, "info");

  await sessionStore.updateSession("session_dirty_history", { status: "running" });
  const activeDiagnostics = await collectCodexTuiRuntimeDiagnostics({
    workspaceRoot: repo,
    store: makeStore([]),
    config: { codexTuiEnabled: true },
    env: {},
  });
  const activeDirty = activeDiagnostics.findings.find((finding) => finding.code === "codex_tui_dirty_worktree");
  assert.equal(activeDirty.severity, "warning");
  assert.equal(activeDirty.historical, undefined);
  assert.equal(activeDiagnostics.highest_severity, "warning");
});

test("recovery status and diagnose include codex_tui_goal diagnostics when relevant", async () => {
  const repo = await makeGitRepo("codex-tui-runtime-recovery-");
  const sessionStore = createCodexTuiSessionStore({ workspaceRoot: repo });
  await sessionStore.createSession({
    sessionId: "session_recovery",
    taskId: "task_tui",
    goalId: "goal_recovery",
    cwd: repo,
  });
  const store = makeStore([{ id: "task_tui", metadata: { codex_execution_provider: "codex_tui_goal" } }]);
  const config = {
    defaultWorkspaceRoot: repo,
    defaultRepoPath: repo,
    recoveryPlaneEnabled: true,
    breakGlassEnabled: false,
    recoveryUnrestrictedLocalCommandEnabled: false,
    recoveryAuditLog: join(repo, ".gptwork", "admin-audit.jsonl"),
    codexTuiEnabled: true,
  };
  const tools = createRecoveryToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    config,
    envLoadResult: { loadedPath: null, keys: [] },
    sources: {},
    registry: {},
    workerState: { enabled: false, running: false },
    collectWorkerQueueCounts: async () => ({ blocked: 0, waiting_for_lock: 0 }),
    repoDir: repo,
    gitInfo: {},
    PROCESS_STARTED_AT: new Date("2026-01-01T00:00:00Z"),
  });

  const status = await tools.recovery_plane_status.handler({});
  const diagnose = await tools.recovery_diagnose.handler({});

  assert.equal(status.codex_tui_goal.provider, "codex_tui_goal");
  assert.equal(status.codex_tui_goal.optional, false);
  assert.equal(status.codex_tui_goal.activation, "default_autonomous");
  assert.ok(diagnose.codex_tui_goal.findings.some((finding) => finding.code === "codex_tui_no_result"));
  assert.ok(diagnose.issues.some((issue) => issue.category === "codex_tui_goal" && /codex_tui_no_result/.test(issue.detail)));
});
