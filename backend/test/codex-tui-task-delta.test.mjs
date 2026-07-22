import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskDelta, renderDeltaInstruction } from "../src/codex-tui-task-delta.mjs";

const session = {
  task_id: "task_1",
  goal_id: "goal_1",
  task_context_digest: "sha256:abc",
  active_delta_revision: 0,
};

test("supervisor_correction is normalized to same-goal correction", () => {
  const validated = validateTaskDelta({
    kind: "supervisor_correction",
    task_id: "task_1",
    goal_id: "goal_1",
    base_context_digest: "sha256:abc",
    revision: 1,
    instruction: "Correct the drift and continue the current goal.",
  }, session);

  assert.equal(validated.kind, "correction");
  assert.match(renderDeltaInstruction(validated), /kind=correction/);
  assert.match(renderDeltaInstruction(validated), /continue the current goal/);
});

test("context digest comparison tolerates transport whitespace and hex casing", () => {
  const validated = validateTaskDelta({
    kind: "correction",
    task_id: "task_1",
    goal_id: "goal_1",
    base_context_digest: "  SHA256:ABC  ",
    revision: 1,
    instruction: "Continue.",
  }, session);
  assert.equal(validated.base_context_digest, "sha256:abc");
});


test("validateTaskDelta allows correction when session digest is not yet available", () => {
  const session = {
    task_id: "task_1",
    goal_id: "goal_1",
    task_context_digest: null,
    active_delta_revision: 0,
  };
  const delta = validateTaskDelta({
    kind: "correction",
    task_id: "task_1",
    goal_id: "goal_1",
    revision: 1,
    base_context_digest: "sha256:abc",
    instruction: "stay on theme",
  }, session);
  assert.equal(delta.kind, "correction");
  assert.equal(delta.base_context_digest, "sha256:abc");
});

test("validateTaskDelta allows correction with no digests during bootstrap", () => {
  const session = {
    task_id: "task_1",
    goal_id: "goal_1",
    task_context_digest: null,
    active_delta_revision: 0,
  };
  const delta = validateTaskDelta({
    kind: "correction",
    task_id: "task_1",
    goal_id: "goal_1",
    revision: 1,
    instruction: "stay on theme",
  }, session);
  assert.equal(delta.digest_deferred, true);
  assert.equal(delta.base_context_digest, null);
});
