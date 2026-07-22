import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTuiSessionLiveness,
  buildTaskRuntimeAggregate,
  RECOMMENDED_ACTION,
} from "../src/runtime/task-runtime-aggregate.mjs";

const now = Date.parse("2026-07-22T16:00:00.000Z");
const recent = "2026-07-22T15:59:30.000Z";
const old = "2020-01-01T00:00:00.000Z";

function tuiTask(extra = {}) {
  return {
    id: "task_tui",
    status: "running",
    metadata: { codex_execution_provider: "codex_tui_goal" },
    acceptance_contract: { mode: "full", retry_policy: { no_progress_timeout_ms: 180000, wake_grace_ms: 30000 } },
    ...extra,
  };
}

test("liveness: running + alive pid + fresh heartbeat => live", () => {
  const out = assessTuiSessionLiveness({
    task: tuiTask(),
    processInfo: { exists: true, last_heartbeat_at: recent },
    sessionInfo: { status: "running", last_meaningful_progress_at: recent },
    now,
    noProgressTimeoutMs: 180000,
  });
  assert.equal(out, "live");
});

test("liveness: running + dead pid => dead", () => {
  const out = assessTuiSessionLiveness({
    task: tuiTask(),
    processInfo: { exists: false, last_heartbeat_at: old },
    sessionInfo: { status: "running", last_meaningful_progress_at: old },
    now,
    noProgressTimeoutMs: 180000,
  });
  assert.equal(out, "dead");
});

test("liveness: running + alive pid + expired progress => stale", () => {
  const out = assessTuiSessionLiveness({
    task: tuiTask(),
    processInfo: { exists: true, last_heartbeat_at: old },
    sessionInfo: { status: "running", last_meaningful_progress_at: old, last_output_at: old },
    now,
    noProgressTimeoutMs: 180000,
  });
  assert.equal(out, "stale");
});

test("liveness: created within start grace => starting", () => {
  const out = assessTuiSessionLiveness({
    task: tuiTask(),
    processInfo: { exists: null },
    sessionInfo: { status: "created", last_meaningful_progress_at: recent },
    now,
    noProgressTimeoutMs: 180000,
    startGraceMs: 60000,
  });
  assert.equal(out, "starting");
});

test("aggregate: dead TUI pid still stop_retry despite status=running", async () => {
  const aggregate = await buildTaskRuntimeAggregate({
    task: tuiTask(),
    session: {
      id: "s",
      status: "running",
      pty_pid: 99999999,
      started_at: old,
      last_meaningful_progress_at: old,
      last_process_heartbeat_at: old,
    },
    lock: { task_id: "task_tui", status: "acquired" },
    now,
    config: { noProgressTimeoutMs: 1, wakeGraceMs: 0 },
  });
  assert.equal(aggregate.recommended_action, RECOMMENDED_ACTION.STOP_RETRY);
});

test("aggregate: live TUI pid with fresh progress continues", async () => {
  const aggregate = await buildTaskRuntimeAggregate({
    task: tuiTask(),
    session: {
      id: "s",
      status: "running",
      pty_pid: process.pid,
      started_at: recent,
      last_meaningful_progress_at: recent,
      last_process_heartbeat_at: recent,
      last_output_at: recent,
    },
    lock: { task_id: "task_tui", status: "acquired" },
    now,
    config: { noProgressTimeoutMs: 180000, wakeGraceMs: 30000 },
  });
  assert.equal(aggregate.recommended_action, RECOMMENDED_ACTION.CONTINUE);
});
