import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeStore() {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "codex-tui-store-")));
  return { workspaceRoot, store: createCodexTuiSessionStore({ workspaceRoot }) };
}

test("session store creates, reads, updates, and lists records", async () => {
  const { store } = await makeStore();
  const created = await store.createSession({
    sessionId: "session_1",
    taskId: "task_1",
    goalId: "goal_1",
    cwd: "/repo",
    repoLockId: "lock_1",
  });

  assert.equal(created.id, "session_1");
  assert.equal(created.status, "created");
  assert.equal(created.task_id, "task_1");
  assert.equal(created.goal_id, "goal_1");
  assert.equal(created.autopilot_state, "created");
  assert.equal(created.action_attempts, 0);
  assert.equal(created.checkpoint, null);

  const updated = await store.updateSession("session_1", { status: "running", pty_pid: 123 });
  assert.equal(updated.status, "running");
  assert.equal(updated.pty_pid, 123);
  assert.ok(updated.updated_at >= created.created_at);

  const read = await store.readSession("session_1");
  assert.equal(read.status, "running");

  const listed = await store.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "session_1");
});

test("session store appends logs and reads bounded tails", async () => {
  const { store, workspaceRoot } = await makeStore();
  await store.createSession({ sessionId: "session_logs", taskId: "task_1", goalId: "goal_1" });
  await store.appendSessionLog("session_logs", "first");
  await store.appendSessionLog("session_logs", "second");

  const record = await store.readSession("session_logs", { maxChars: 8 });
  assert.equal(record.log, "\nsecond\n".slice(-8));

  const logText = await readFile(join(workspaceRoot, ".gptwork", "codex-tui-sessions", "session_logs.log"), "utf8");
  assert.match(logText, /first\nsecond\n/);
});

test("session store rejects unsafe session ids", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.createSession({ sessionId: "../escape" }), /unsafe session id/);
  await assert.rejects(() => store.readSession("nested/session"), /unsafe session id/);
  await assert.rejects(() => store.updateSession("session.json", { status: "running" }), /unsafe session id/);
  await assert.rejects(() => store.appendSessionLog("..", "x"), /unsafe session id/);
});
