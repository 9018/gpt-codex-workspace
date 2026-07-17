import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchTaskProvider } from "../src/task-processing/task-provider-dispatcher.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function input(root, task = {}) {
  return {
    workspaceRoot: root,
    task: { id: "task_dispatch", metadata: {}, ...task },
    goal: { id: "goal_dispatch" },
    executionCwd: join(root, ".gptwork", "worktrees", "task_dispatch"),
    pathContext: { execution_cwd: join(root, ".gptwork", "worktrees", "task_dispatch") },
    inputSnapshot: { digest: "input-v1" },
    context: { workspaceRoot: root },
  };
}

test("default TUI and explicit exec enter one dispatcher and persist provider-neutral evidence", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "task-provider-dispatcher-")));
  const calls = [];
  const providers = {
    codex_exec: {
      name: "codex_exec",
      revision: "test-exec",
      async availability() { return true; },
      async start(attempt) { calls.push(["codex_exec", attempt.task_id]); return { id: attempt.id }; },
      async observe() { return { state: "evidence_ready" }; },
      async collect() { return { status: "completed", summary: "exec done", changed_files: [], tests: [] }; },
      async send() {}, async interrupt() {}, async resume(attempt) { return this.start(attempt); }, async dispose() {},
    },
    codex_tui: {
      name: "codex_tui",
      revision: "test-tui",
      async availability() { return true; },
      async start(attempt) { calls.push(["codex_tui", attempt.task_id]); return { id: attempt.id }; },
      async observe() { return { state: "evidence_ready" }; },
      async collect() { return { status: "completed", summary: "tui done", changed_files: [], tests: [] }; },
      async send() {}, async interrupt() {}, async resume(attempt) { return this.start(attempt); }, async dispose() {},
    },
  };

  const tui = await dispatchTaskProvider(input(root), { providers });
  const exec = await dispatchTaskProvider(input(root, {
    id: "task_dispatch_exec",
    metadata: { codex_execution_provider: "codex_exec" },
  }), { providers });

  assert.deepEqual(calls, [
    ["codex_tui", "task_dispatch"],
    ["codex_exec", "task_dispatch_exec"],
  ]);
  assert.equal(exec.provider, "codex_exec");
  assert.equal(tui.provider, "codex_tui");
  assert.equal(exec.evidence.summary, "exec done");
  assert.equal(tui.evidence.summary, "tui done");
  assert.equal(exec.attempt.state, "completed");
  assert.equal(tui.attempt.state, "completed");
});

test("explicit unavailable TUI does not automatically fall back to exec", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "task-provider-unavailable-")));
  const calls = [];
  const providers = {
    codex_exec: {
      name: "codex_exec", async availability() { return true; },
      async start(attempt) { calls.push(["start", attempt.provider]); return { id: attempt.id }; },
      async observe() { return { state: "evidence_ready" }; },
      async collect() { return { status: "completed", summary: "exec fallback done" }; },
      async send() {}, async interrupt() {}, async resume(attempt) { return this.start(attempt); }, async dispose() {},
    },
    codex_tui: {
      name: "codex_tui", async availability() { return false; },
      async start() {}, async observe() {}, async collect() {}, async send() {}, async interrupt() {}, async resume() {}, async dispose() {},
    },
  };

  const result = await dispatchTaskProvider(input(root, {
    metadata: { codex_execution_provider: "codex_tui_goal" },
  }), { providers });

  assert.equal(result.status, "waiting_for_supervisor");
  assert.equal(result.provider, "codex_tui");
  assert.equal(result.failure.code, "tui_unavailable");
  assert.deepEqual(calls, []);
  assert.notEqual(result.status, "waiting_for_review");
  assert.notEqual(result.status, "waiting_for_operator");
});
