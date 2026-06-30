import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendWorkflowRunEvent,
  createWorkflowRun,
  diagnoseWorkflowRun,
  loadWorkflowRun,
  transitionWorkflowRun,
} from "../src/workflow-run-store.mjs";

function workspaceRoot() {
  return mkdtempSync(join(tmpdir(), `gptwork-wfrun-${process.pid}-`));
}

test("workflow_run store creates a persisted run and records transition events", () => {
  const root = workspaceRoot();
  const run = createWorkflowRun(root, {
    workflow_id: "default",
    goal_id: "goal_1",
    task_id: "task_1",
    current_step: "goal_created",
  });

  assert.equal(run.run_id, "task_1");
  assert.equal(run.status, "created");
  assert.equal(run.current_step, "goal_created");
  assert.equal(run.goal_id, "goal_1");
  assert.equal(run.task_id, "task_1");
  assert.equal(run.events.length, 1);
  assert.equal(run.events[0].type, "workflow_run.created");

  const transitioned = transitionWorkflowRun(root, "task_1", {
    to_status: "running",
    current_step: "codex_execution",
    reason: "worker picked up task",
  });

  assert.equal(transitioned.status, "running");
  assert.equal(transitioned.current_step, "codex_execution");
  assert.equal(transitioned.events.at(-1).type, "workflow_run.transitioned");
  assert.deepEqual(transitioned.events.at(-1).from_status, "created");

  const reloaded = loadWorkflowRun(root, "task_1");
  assert.equal(reloaded.status, "running");
  assert.equal(reloaded.events.length, 2);
});

test("workflow_run transitions reject illegal status moves", () => {
  const root = workspaceRoot();
  createWorkflowRun(root, { task_id: "task_illegal" });
  assert.throws(
    () => transitionWorkflowRun(root, "task_illegal", { to_status: "completed", current_step: "done" }),
    /illegal workflow_run transition: created -> completed/
  );
});

test("workflow_run diagnostics report stale active runs and blocking reasons", () => {
  const root = workspaceRoot();
  createWorkflowRun(root, { task_id: "task_blocked" });
  transitionWorkflowRun(root, "task_blocked", {
    to_status: "blocked",
    current_step: "queue_wait",
    reason: "repo locked by task_x",
    blocker: { code: "repo_lock", detail: "repo locked by task_x" },
  });
  appendWorkflowRunEvent(root, "task_blocked", "workflow_run.note", { detail: "manual inspection" });

  const diagnostics = diagnoseWorkflowRun(root, "task_blocked", {
    now: "2999-01-01T00:10:00.000Z",
    staleAfterMs: 60_000,
  });

  assert.equal(diagnostics.status, "blocked");
  assert.equal(diagnostics.current_step, "queue_wait");
  assert.equal(diagnostics.blocking_reason, "repo locked by task_x");
  assert.equal(diagnostics.stale, true);
  assert.equal(diagnostics.event_count, 3);
});

test("workflow_run store writes JSON under .gptwork/workflow_runs", () => {
  const root = workspaceRoot();
  createWorkflowRun(root, { task_id: "task_file", workflow_id: "wf" });
  const raw = readFileSync(join(root, ".gptwork", "workflow_runs", "task_file.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.workflow_id, "wf");
  assert.equal(parsed.schema_version, 1);
});
