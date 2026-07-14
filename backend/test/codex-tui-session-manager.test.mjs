import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readlink } from "node:fs/promises";
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
  return {
    spawns,
    writes,
    stops,
    emitData(text) { onData?.(text); },
    async spawn(options) {
      spawns.push(options);
      onData = options.onData;
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
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stop_reason, "test complete");
  assert.deepEqual(fakeAdapter.stops, [undefined]);

  const stoppedStatus = await getCodexTuiSessionStatus(session.id);
  assert.equal(stoppedStatus.status, "stopped");
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

  await assert.rejects(
    () => startCodexTuiGoalSession({
      task: { id: "task_spawn_fail", title: "Spawn fail" },
      goal: { id: "goal_spawn_fail" },
      cwd,
      workspaceRoot,
      ptyAdapter: failingAdapter,
    }),
    /no PTY/
  );

  const store = createCodexTuiSessionStore({ workspaceRoot });
  const record = await store.readSession("goal_spawn_fail_task_spawn_fail", { maxChars: 0 });
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "codex_tui_unavailable");
  assert.match(record.error, /no PTY/);
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
