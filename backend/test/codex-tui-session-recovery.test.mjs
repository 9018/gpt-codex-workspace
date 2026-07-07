import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexTuiSessionStore } from "../src/codex-tui-session-store.mjs";
import { getCodexTuiSessionStatus, readCodexTuiSession, resetCodexTuiSessionManagerForTests } from "../src/codex-tui-session-manager.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

test.afterEach(() => {
  resetCodexTuiSessionManagerForTests();
});

test("recorded TUI sessions are readable after manager memory reset", async () => {
  const cwd = track(await mkdtemp(join(tmpdir(), "codex-tui-recovery-")));
  const store = createCodexTuiSessionStore({ workspaceRoot: cwd });
  await store.createSession({ sessionId: "recorded_1", taskId: "task_1", goalId: "goal_1", cwd });
  await store.updateSession("recorded_1", { status: "running", pty_pid: 999999999 });
  await store.appendSessionLog("recorded_1", "durable output");

  resetCodexTuiSessionManagerForTests();

  const status = await getCodexTuiSessionStatus("recorded_1", { workspaceRoot: cwd });
  assert.equal(status.status, "detached");
  assert.equal(status.pid_alive, false);
  assert.equal(status.detach_reason, "pty_process_not_alive");

  const read = await readCodexTuiSession("recorded_1", { workspaceRoot: cwd });
  assert.equal(read.status, "detached");
  assert.match(read.log, /durable output/);
});
