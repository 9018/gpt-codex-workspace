import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExecutionAttemptStore } from "../src/execution/execution-attempt-store.mjs";
import { afterEachHook, track } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

test("attempt store compare-and-swap allows only one active attempt per task", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "attempt-store-")));
  const store = createExecutionAttemptStore({ workspaceRoot: root });

  const first = await store.claim({ taskId: "task_1", goalId: "goal_1", provider: "codex_exec" });
  assert.equal(first.claimed, true);
  assert.equal(first.attempt.attempt_number, 1);

  const competing = await store.claim({ taskId: "task_1", goalId: "goal_1", provider: "codex_tui" });
  assert.equal(competing.claimed, false);
  assert.equal(competing.active_attempt.id, first.attempt.id);

  await store.transition(first.attempt.id, { expectedState: "starting", state: "failed" });
  const retry = await store.claim({ taskId: "task_1", goalId: "goal_1", provider: "codex_tui" });
  assert.equal(retry.claimed, true);
  assert.equal(retry.attempt.attempt_number, 2);
});

test("attempt store transition is CAS guarded and persists checkpoint and evidence", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "attempt-cas-")));
  const store = createExecutionAttemptStore({ workspaceRoot: root });
  const { attempt } = await store.claim({
    taskId: "task_2",
    goalId: "goal_2",
    provider: "codex_exec",
    inputSnapshot: { digest: "input-1" },
    pathContext: { execution_cwd: root },
  });

  await assert.rejects(
    store.transition(attempt.id, { expectedState: "running", state: "completed" }),
    /compare-and-swap/,
  );

  const running = await store.transition(attempt.id, {
    expectedState: "starting",
    state: "running",
    providerHandle: { pid: 42 },
    checkpoint: { head: "abc" },
  });
  assert.equal(running.provider_handle.pid, 42);
  assert.equal(running.checkpoint.head, "abc");

  const done = await store.transition(attempt.id, {
    expectedState: "running",
    state: "completed",
    evidence: { status: "completed", tests: [] },
  });
  assert.equal(done.evidence.status, "completed");
  assert.equal((await store.getActiveForTask("task_2")), null);
});
