import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startCodexTuiGoalSession,
  readCodexTuiSession,
  sendCodexTuiSessionInput,
  stopCodexTuiSession,
  getCodexTuiSessionStatus,
  resetCodexTuiSessionManagerForTests,
} from "../src/codex-tui-session-manager.mjs";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

test.afterEach(() => {
  resetCodexTuiSessionManagerForTests();
});

function makeFakeAdapter() {
  const spawns = [];
  const writes = [];
  const stops = [];
  let onData = null;
  let onExit = null;
  return {
    spawns,
    writes,
    stops,
    emitData(text) { onData?.(text); },
    emitExit(event) { onExit?.(event); },
    async spawn(options) {
      spawns.push(options);
      onData = options.onData;
      onExit = options.onExit;
      // Emit a ready signal so waitForTuiOutput can detect TUI readiness
      setTimeout(() => onData?.("TUI ready \x1b[1m$\x1b[0m "), 10);
      return {
        pid: 99,
        write(text) { writes.push(text); },
        stop(reason) { stops.push(reason); },
      };
    },
  };
}

async function readResult(workspaceRoot, goalId) {
  return JSON.parse(await readFile(join(workspaceRoot, ".gptwork", "goals", goalId, "result.json"), "utf8"));
}

test("start passes the goal as the interactive Codex initial prompt", async () => {
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-manager-")));
  const fakeAdapter = makeFakeAdapter();
  const session = await startCodexTuiGoalSession({
    task: { id: "task_1", title: "TUI foundation" },
    goal: { id: "goal_1" },
    cwd,
    repoLockId: "lock_1",
    ptyAdapter: fakeAdapter,
  });

  assert.equal(session.status, "running");
  assert.equal(session.task_id, "task_1");
  assert.equal(session.goal_id, "goal_1");
  assert.equal(session.bootstrap_method, "argv_prompt_enter");
  assert.equal(fakeAdapter.spawns.length, 1);
  assert.equal(fakeAdapter.spawns[0].cwd, cwd);
  assert.equal(fakeAdapter.spawns[0].args.length, 1);
  assert.match(fakeAdapter.spawns[0].args[0], /goal_id=goal_1/);
  assert.match(fakeAdapter.spawns[0].args[0], /Use Superpowers/);
  assert.match(fakeAdapter.spawns[0].args[0], /codex\.entry\.md/);
  assert.ok(fakeAdapter.spawns[0].args[0].includes(`.gptwork/runtime-goals/goal_1/codex.entry.md`));
  assert.equal(await readlink(join(cwd, ".gptwork", "runtime-goals", "goal_1")), join(cwd, ".gptwork", "goals", "goal_1"));
  assert.deepEqual(fakeAdapter.writes, ["\r"], "argv prompt must be submitted exactly once after the TUI first renders");

  const read = await readCodexTuiSession(session.id);
  assert.match(read.log, /TUI ready/);
});




test("start persists workstream, execution and context bindings", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-binding-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-binding-cwd-")));
  const fakeAdapter = makeFakeAdapter();
  const session = await startCodexTuiGoalSession({
    task: { id: "task_binding", title: "Binding" },
    goal: { id: "goal_binding" },
    cwd,
    workspaceRoot,
    repoLockId: "lock_binding",
    workstreamId: "ws_binding",
    executionId: "exec_binding",
    worktreePath: cwd,
    branch: "gptwork/task/task_binding",
    baseCommit: "abc123",
    headCommit: "abc123",
    taskContextDigest: "sha256:task-binding",
    taskContextRevision: 2,
    workstreamContextDigest: "sha256:ws-binding",
    workstreamContextRevision: 7,
    ptyAdapter: fakeAdapter,
  });

  assert.equal(session.runtime_version, 3);
  assert.equal(session.workstream_id, "ws_binding");
  assert.equal(session.execution_id, "exec_binding");
  assert.equal(session.worktree_path, cwd);
  assert.equal(session.branch, "gptwork/task/task_binding");
  assert.equal(session.base_commit, "abc123");
  assert.equal(session.head_commit, "abc123");
  assert.equal(session.task_context_digest, "sha256:task-binding");
  assert.equal(session.task_context_revision, 2);
  assert.equal(session.workstream_context_digest, "sha256:ws-binding");
  assert.equal(session.workstream_context_revision, 7);
  assert.equal(session.active_delta_revision, 0);
});

test("start binds TUI environment and native Codex session to the project manifest", async () => {
  const projectRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-native-project-")));
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-native-workspace-")));
  const codexHome = join(projectRoot, ".codex-runtime");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const pathContext = {
    projectRoot,
    canonicalRepoPath: projectRoot,
    executionCwd: projectRoot,
    worktreePath: null,
    codexHome,
    nativeSessionsRoot: join(codexHome, "sessions"),
  };
  const fakeAdapter = makeFakeAdapter();
  fakeAdapter.spawn = async function spawn(options) {
    this.spawns.push(options);
    setTimeout(() => options.onData?.("session id: native-tui-1\nTUI ready $ "), 10);
    return {
      pid: 101,
      write: (text) => this.writes.push(text),
      stop: (reason) => this.stops.push(reason),
    };
  };

  const session = await startCodexTuiGoalSession({
    task: { id: "task_native", title: "Native binding" },
    goal: { id: "goal_native" },
    cwd: projectRoot,
    workspaceRoot,
    executionId: "exec-native",
    pathContext,
    ptyAdapter: fakeAdapter,
  });

  assert.equal(fakeAdapter.spawns[0].env.CODEX_HOME, codexHome);
  assert.equal(fakeAdapter.spawns[0].env.GPTWORK_CONTROL_SESSION_ID, session.id);
  assert.equal(session.native_session_id, "native-tui-1");
  assert.equal(session.native_session_binding_source, "process_output");
  const manifest = JSON.parse(await readFile(join(
    projectRoot,
    ".gptwork",
    "codex-sessions",
    "manifests",
    `${session.id}.json`,
  ), "utf8"));
  assert.equal(manifest.native_session_id, "native-tui-1");
  assert.equal(manifest.execution_id, "exec-native");
  assert.equal(manifest.provider, "codex_tui_goal");
});

test("start does not send bootstrap Enter when Codex already auto-submitted the argv prompt", async () => {
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-manager-auto-submit-")));
  const fakeAdapter = makeFakeAdapter();
  fakeAdapter.emitData = () => {};
  fakeAdapter.spawn = async function spawn(options) {
    this.spawns.push(options);
    setTimeout(() => options.onData?.("Working (0s • esc to interrupt)"), 10);
    return {
      pid: 100,
      write: (text) => this.writes.push(text),
      stop: (reason) => this.stops.push(reason),
    };
  };

  const session = await startCodexTuiGoalSession({
    task: { id: "task_auto_submit", title: "Auto submitted" },
    goal: { id: "goal_auto_submit" },
    cwd,
    repoLockId: "lock_auto_submit",
    ptyAdapter: fakeAdapter,
  });

  assert.equal(session.bootstrap_method, "argv_prompt_auto_submitted");
  assert.deepEqual(fakeAdapter.writes, []);
});

test("manager sends input, reads status, and stops sessions safely", async () => {
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-manager-")));
  const fakeAdapter = makeFakeAdapter();
  const session = await startCodexTuiGoalSession({
    task: { id: "task_2", title: "TUI foundation" },
    goal: { id: "goal_2" },
    cwd,
    repoLockId: "lock_2",
    ptyAdapter: fakeAdapter,
  });

  await sendCodexTuiSessionInput(session.id, "continue\n");
  assert.equal(fakeAdapter.writes.at(-1), "continue\n");

  const status = await getCodexTuiSessionStatus(session.id);
  assert.equal(status.status, "running");
  assert.equal(status.pid, 99);

  const stopped = await stopCodexTuiSession(session.id, { reason: "test complete" });
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.terminal_event_count, 1);
  assert.equal(stopped.terminal_event.source, "explicit-stop");
  assert.deepEqual(fakeAdapter.stops, [undefined]);
  const result = await readResult(cwd, "goal_2");
  assert.equal(result.status, "failed");
  assert.equal(result.terminal_event.source, "explicit-stop");

  const stoppedStatus = await getCodexTuiSessionStatus(session.id);
  assert.equal(stoppedStatus.status, "failed");
});

// recovery test appended by ChatGPT


test("stores session metadata under explicit workspaceRoot instead of cwd", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-workspace-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-cwd-")));
  const fakeAdapter = makeFakeAdapter();
  const session = await startCodexTuiGoalSession({
    task: { id: "task_root", title: "Root config" },
    goal: { id: "goal_root" },
    cwd,
    workspaceRoot,
    command: "codex-custom",
    evidenceWaitMs: 1234,
    requireSuperpowers: true,
    ptyAdapter: fakeAdapter,
  });

  assert.equal(session.session_store_root, workspaceRoot);
  assert.equal(session.workspace_root, workspaceRoot);
  assert.equal(session.deprecated_cwd_session_root, false);
  assert.equal(fakeAdapter.spawns[0].cwd, cwd);
  assert.equal(fakeAdapter.spawns[0].command, "codex-custom");
  assert.ok(fakeAdapter.spawns[0].args[0].includes(`.gptwork/runtime-goals/goal_root/codex.entry.md`));
  assert.ok(!fakeAdapter.spawns[0].args[0].includes(workspaceRoot));
  assert.equal(await readlink(join(cwd, ".gptwork", "runtime-goals", "goal_root")), join(workspaceRoot, ".gptwork", "goals", "goal_root"));

  const workspaceStore = createCodexTuiSessionStore({ workspaceRoot });
  const cwdStore = createCodexTuiSessionStore({ workspaceRoot: cwd });
  const stored = await workspaceStore.readSession(session.id, { maxChars: 0 });
  assert.equal(stored.metadata.session_store_root, workspaceRoot);
  assert.equal(stored.metadata.evidence_wait_ms, 1234);
  await assert.rejects(() => cwdStore.readSession(session.id, { maxChars: 0 }), /ENOENT|no such file/i);
});

test("spawn failure marks the durable session failed instead of leaving created", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-spawn-fail-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-spawn-fail-cwd-")));
  const failingAdapter = {
    async spawn() {
      const err = new Error("no PTY");
      err.code = "codex_tui_unavailable";
      throw err;
    },
  };
  let released = 0;

  await assert.rejects(
    () => startCodexTuiGoalSession({
      task: { id: "task_spawn_fail", title: "Spawn fail" },
      goal: { id: "goal_spawn_fail" },
      cwd,
      workspaceRoot,
      ptyAdapter: failingAdapter,
      releaseLockFn: async () => { released += 1; },
    }),
    /no PTY/
  );

  const store = createCodexTuiSessionStore({ workspaceRoot });
  const record = await store.readSession("goal_spawn_fail_task_spawn_fail", { maxChars: 0 });
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "codex_tui_unavailable");
  assert.match(record.error, /no PTY/);
  assert.equal(record.terminal_event_count, 1);
  assert.equal(released, 1);
  const result = await readResult(workspaceRoot, "goal_spawn_fail");
  assert.equal(result.status, "failed");
  assert.match(result.summary, /no PTY/);
  assert.deepEqual(result.changed_files, []);
  assert.equal(result.verification.passed, false);
});

test("spontaneous PTY exit writes one terminal result and releases the task lock", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-exit-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-exit-cwd-")));
  const fakeAdapter = makeFakeAdapter();
  let released = 0;
  const session = await startCodexTuiGoalSession({
    task: { id: "task_exit", title: "Exit" },
    goal: { id: "goal_exit" },
    cwd,
    workspaceRoot,
    repoLockId: "lock_exit",
    ptyAdapter: fakeAdapter,
    releaseLockFn: async () => { released += 1; },
  });

  fakeAdapter.emitExit({ exit_code: 9, signal: "SIGTERM", source: "test-exit" });
  fakeAdapter.emitExit({ exit_code: 9, signal: "SIGTERM", source: "duplicate-exit" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const record = await readCodexTuiSession(session.id, { workspaceRoot, maxChars: 0 });
  assert.equal(record.status, "failed");
  assert.equal(record.terminal_event_count, 1);
  assert.equal(record.terminal_event.exit_code, 9);
  assert.equal(released, 1);
  const result = await readResult(workspaceRoot, "goal_exit");
  assert.equal(result.status, "failed");
  assert.equal(result.terminal_event.exit_code, 9);
  assert.equal(result.commit, "none");
  assert.equal(result.remote_head, "none");
});

test("PTY exit during spawn cannot leave a terminal session active", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-sync-exit-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-sync-exit-cwd-")));
  let released = 0;
  const adapter = {
    async spawn(options) {
      options.onData?.("TUI ready before immediate exit");
      options.onExit?.({ exit_code: 17, signal: null, source: "sync-spawn-exit" });
      return { pid: 1717, write() {}, stop() {} };
    },
  };

  const session = await startCodexTuiGoalSession({
    task: { id: "task_sync_exit", title: "Sync exit" },
    goal: { id: "goal_sync_exit" },
    cwd,
    workspaceRoot,
    ptyAdapter: adapter,
    releaseLockFn: async () => { released += 1; },
  });

  assert.equal(session.status, "failed");
  assert.equal(session.terminal_event_count, 1);
  assert.equal(released, 1);
  await assert.rejects(
    () => sendCodexTuiSessionInput(session.id, "must not be accepted\n", { workspaceRoot }),
    /not active/i,
  );
});

test("explicit stop and later PTY exit share one terminal event and preserve durable completion", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-stop-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-stop-cwd-")));
  const goalDir = join(workspaceRoot, ".gptwork", "goals", "goal_stop");
  await mkdir(goalDir, { recursive: true });
  await writeFile(join(goalDir, "result.json"), JSON.stringify({
    status: "completed",
    summary: "durable completion",
    changed_files: [],
    tests: "focused test passed",
    commit: "none",
    remote_head: "none",
    warnings: [],
    followups: [],
    verification: { passed: true, commands: [{ cmd: "focused test", exit_code: 0, passed: true }] },
  }, null, 2));
  const fakeAdapter = makeFakeAdapter();
  let released = 0;
  const session = await startCodexTuiGoalSession({
    task: { id: "task_stop", title: "Stop" },
    goal: { id: "goal_stop" },
    cwd,
    workspaceRoot,
    ptyAdapter: fakeAdapter,
    releaseLockFn: async () => { released += 1; },
  });

  await stopCodexTuiSession(session.id, { reason: "manual_stop", workspaceRoot });
  fakeAdapter.emitExit({ exit_code: 0, signal: null, source: "late-exit" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const record = await readCodexTuiSession(session.id, { workspaceRoot, maxChars: 0 });
  assert.equal(record.status, "completed");
  assert.equal(record.terminal_event_count, 1);
  assert.equal(released, 1);
  const result = await readResult(workspaceRoot, "goal_stop");
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "durable completion");
});


test("concurrent starts for the same session are idempotent and conflicting cwd is rejected", async () => {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-concurrent-root-")));
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-concurrent-cwd-")));
  const otherCwd = track(await mkdtemp(join(tmpdir(), "codex-tui-concurrent-other-")));
  let spawnCount = 0;
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
  const adapter = {
    async spawn() {
      spawnCount += 1;
      await spawnGate;
      return { pid: 424242, write() {}, stop() {} };
    },
  };
  const args = {
    task: { id: "task_concurrent", title: "Concurrent" },
    goal: { id: "goal_concurrent" },
    cwd,
    workspaceRoot,
    ptyAdapter: adapter,
  };
  const first = startCodexTuiGoalSession(args);
  const second = startCodexTuiGoalSession(args);
  await assert.rejects(
    () => startCodexTuiGoalSession({ ...args, cwd: otherCwd }),
    (err) => err?.code === "codex_tui_session_conflict"
  );
  releaseSpawn();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(spawnCount, 1);
  assert.equal(a.id, b.id);
  await stopCodexTuiSession(a.id, { workspaceRoot });
});

test("isolated worktree cleanup terminates matching cwd processes and escalates survivors", async () => {
  const { cleanupIsolatedWorktreeProcesses } = await import("../src/codex-tui-session-manager.mjs");
  const target = "/tmp/.gptwork/worktrees/repo/task_1";
  let phase = 0;
  const kills = [];
  const cwdByPid = new Map([[101, target], [102, target], [103, "/tmp/other"], [999, target]]);
  const result = await cleanupIsolatedWorktreeProcesses({
    cwd: target,
    currentPid: 999,
    readdirFn: async () => ["101", "102", "103", "999", "self"],
    readlinkFn: async (path) => {
      const pid = Number(path.split("/").at(-2));
      if (phase >= 1 && pid === 101) return "/exited";
      if (phase >= 2 && pid === 102) return "/exited";
      return cwdByPid.get(pid) || "/unknown";
    },
    killFn: (pid, signal) => { kills.push([pid, signal]); if (signal === "SIGTERM") phase = 1; else phase = 2; },
    sleepFn: async () => {},
    graceMs: 1,
  });
  assert.deepEqual(result.terminated, [101, 102]);
  assert.deepEqual(result.killed, [102]);
  assert.deepEqual(result.surviving, []);
  assert.deepEqual(kills, [[101, "SIGTERM"], [102, "SIGTERM"], [102, "SIGKILL"]]);
});

test("process cleanup refuses non-isolated cwd", async () => {
  const { cleanupIsolatedWorktreeProcesses } = await import("../src/codex-tui-session-manager.mjs");
  const kills = [];
  const result = await cleanupIsolatedWorktreeProcesses({
    cwd: "/home/a9017/mcp/workspace/gpt-codex-workspace",
    killFn: (...args) => kills.push(args),
  });
  assert.equal(result.attempted, false);
  assert.deepEqual(kills, []);
});
