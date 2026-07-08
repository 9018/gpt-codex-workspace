import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

test("start creates session, spawns codex, sends bootstrap messages, and logs output", async () => {
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
  assert.ok(session.first_output_at, "first_output_at should be set when TUI produces output");
  assert.equal(fakeAdapter.spawns.length, 1);
  assert.equal(fakeAdapter.spawns[0].cwd, cwd);
  // Goal objective passed as spawn args, not written to stdin
  assert.ok(fakeAdapter.spawns[0].args, "spawn should receive args array");
  assert.ok(fakeAdapter.spawns[0].args[0], "spawn args[0] should be the goal objective");
  assert.match(fakeAdapter.spawns[0].args[0], /goal_id=goal_1/);
  assert.match(fakeAdapter.spawns[0].args[0], /Use Superpowers/);
  // Only follow-up is written to stdin (no /goal prefix)
  assert.equal(fakeAdapter.writes.length, 1, "only follow-up should be written to stdin");
  assert.match(fakeAdapter.writes[0], /Continue GPTWork goal_id=goal_1/);
  assert.match(fakeAdapter.writes[0], /codex\.entry\.md/);

  const read = await readCodexTuiSession(session.id);
  assert.match(read.log, /TUI ready/);
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
