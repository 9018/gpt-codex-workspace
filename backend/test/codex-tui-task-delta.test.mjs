import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskDelta,
  renderDeltaInstruction,
} from "../src/codex-tui-task-delta.mjs";

function makeSession(overrides = {}) {
  return {
    task_id: "task_1",
    goal_id: "goal_1",
    task_context_digest: "sha256:abc",
    active_delta_revision: 0,
    ...overrides,
  };
}

function makeDelta(overrides = {}) {
  return {
    kind: "new_evidence",
    task_id: "task_1",
    goal_id: "goal_1",
    base_context_digest: "sha256:abc",
    revision: 1,
    findings: ["Found issue"],
    ...overrides,
  };
}

describe("validateTaskDelta", () => {
  it("accepts a valid delta", () => {
    const delta = makeDelta();
    const session = makeSession();
    assert.doesNotThrow(() => validateTaskDelta(delta, session));
  });

  it("accepts correction and instruction deltas", () => {
    for (const kind of ["correction", "instruction"]) {
      const delta = makeDelta({ kind, instruction: "Write CORRECTED and continue." });
      assert.doesNotThrow(() => validateTaskDelta(delta, makeSession()));
      assert.match(renderDeltaInstruction(delta), /Write CORRECTED and continue\./);
    }
  });

  it("rejects unsupported delta kind", () => {
    const delta = makeDelta({ kind: "unknown" });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /unsupported delta kind/);
  });

  it("rejects wrong task_id", () => {
    const delta = makeDelta({ task_id: "task_wrong" });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /task_id does not match/);
  });

  it("rejects wrong goal_id", () => {
    const delta = makeDelta({ goal_id: "goal_wrong" });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /goal_id does not match/);
  });

  it("rejects digest mismatch", () => {
    const delta = makeDelta({ base_context_digest: "sha256:old" });
    assert.throws(
      () => validateTaskDelta(delta, makeSession({ task_context_digest: "sha256:new" })),
      /context digest mismatch/
    );
  });

  it("rejects wrong revision", () => {
    const delta = makeDelta({ revision: 3 });
    assert.throws(() => validateTaskDelta(delta, makeSession({ active_delta_revision: 1 })), /revision must be/);
  });

  it("rejects modification of objective", () => {
    const delta = makeDelta({ objective: "new objective" });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /cannot modify/);
  });

  it("rejects modification of scope", () => {
    const delta = makeDelta({ scope: { include: ["all"], exclude: [] } });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /cannot modify/);
  });

  it("rejects modification of acceptance_criteria", () => {
    const delta = makeDelta({ acceptance_criteria: [] });
    assert.throws(() => validateTaskDelta(delta, makeSession()), /cannot modify/);
  });
});

describe("renderDeltaInstruction", () => {
  it("includes delta metadata in instruction text", () => {
    const delta = makeDelta();
    const instruction = renderDeltaInstruction(delta);
    assert.ok(instruction.includes("BEGIN GPTWORK TASK DELTA"));
    assert.ok(instruction.includes("task_id=task_1"));
    assert.ok(instruction.includes("revision=1"));
    assert.ok(instruction.includes("does not replace objective"));
  });
});
