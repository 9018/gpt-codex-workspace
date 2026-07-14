import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskContextPacket,
  validateTaskContextDelta,
  TASK_CONTEXT_SCHEMA_VERSION,
  FACT_STATUSES,
  IMMUTABLE_AFTER_START,
} from "../src/context-contract/task-context-schema.mjs";

const MINIMAL_PACKET = () => ({
  schema_version: TASK_CONTEXT_SCHEMA_VERSION,
  identity: {
    workstream_id: "ws_test",
    goal_id: null,
    task_id: null,
    context_revision: 1,
  },
  objective: "Implement the feature",
  background: [],
  confirmed_findings: [],
  scope: { include: ["src/"], exclude: ["test/"] },
  required_changes: [],
  acceptance_criteria: [
    { id: "ac1", description: "Tests pass", blocking: true, verification_hint: null },
  ],
  constraints: [],
  open_questions: [],
  carry_forward: [],
  source_provenance: [],
  raw_conversation_policy: {
    stored: true,
    indexed: false,
    injected: false,
    targeted_lookup_allowed: true,
  },
});

describe("validateTaskContextPacket", () => {
  it("accepts a valid minimal packet", () => {
    assert.equal(validateTaskContextPacket(MINIMAL_PACKET()), true);
  });

  it("rejects non-object", () => {
    assert.throws(() => validateTaskContextPacket(null), /must be an object/);
    assert.throws(() => validateTaskContextPacket("string"), /must be an object/);
  });

  it("rejects wrong schema_version", () => {
    const p = MINIMAL_PACKET();
    p.schema_version = "wrong";
    assert.throws(() => validateTaskContextPacket(p), /schema_version/);
  });

  it("rejects missing objective", () => {
    const p = MINIMAL_PACKET();
    p.objective = "";
    assert.throws(() => validateTaskContextPacket(p), /objective/);
  });

  it("rejects invalid fact status", () => {
    const p = MINIMAL_PACKET();
    p.confirmed_findings = [
      { id: "f1", statement: "test", status: "invalid_status", evidence_refs: [] },
    ];
    assert.throws(() => validateTaskContextPacket(p), /finding.status/);
  });

  it("accepts all valid fact statuses", () => {
    for (const status of FACT_STATUSES) {
      const p = MINIMAL_PACKET();
      p.confirmed_findings = [
        { id: "f1", statement: "test", status, evidence_refs: [] },
      ];
      assert.equal(validateTaskContextPacket(p), true);
    }
  });

  it("rejects duplicate acceptance criteria ids", () => {
    const p = MINIMAL_PACKET();
    p.acceptance_criteria = [
      { id: "dup", description: "first", blocking: true },
      { id: "dup", description: "second", blocking: false },
    ];
    assert.throws(() => validateTaskContextPacket(p), /duplicate acceptance criterion id: dup/);
  });

  it("rejects raw_conversation_policy.stored false", () => {
    const p = MINIMAL_PACKET();
    p.raw_conversation_policy.stored = false;
    assert.throws(() => validateTaskContextPacket(p), /stored must default to true/);
  });

  it("rejects raw_conversation_policy.injected true", () => {
    const p = MINIMAL_PACKET();
    p.raw_conversation_policy.injected = true;
    assert.throws(() => validateTaskContextPacket(p), /injected must default to false/);
  });

  it("rejects invalid context_revision", () => {
    const p = MINIMAL_PACKET();
    p.identity.context_revision = 0;
    assert.throws(() => validateTaskContextPacket(p), /context_revision/);
    p.identity.context_revision = "one";
    assert.throws(() => validateTaskContextPacket(p), /context_revision/);
  });

  it("rejects empty acceptance_criteria", () => {
    const p = MINIMAL_PACKET();
    p.acceptance_criteria = [];
    assert.throws(() => validateTaskContextPacket(p), /non-empty array/);
  });
});

describe("validateTaskContextDelta", () => {
  it("accepts a valid delta", () => {
    const packet = MINIMAL_PACKET();
    const delta = {
      kind: "new_evidence",
      task_id: null,
      goal_id: null,
      revision: 2,
      findings: [],
    };
    assert.equal(validateTaskContextDelta(delta, packet), true);
  });

  it("rejects unsupported delta kind", () => {
    assert.throws(
      () => validateTaskContextDelta({ kind: "unknown", task_id: null, goal_id: null }, MINIMAL_PACKET()),
      /unsupported kind/
    );
  });

  it("rejects delta with immutable field", () => {
    assert.throws(
      () =>
        validateTaskContextDelta(
          { kind: "new_evidence", task_id: null, goal_id: null, objective: "new" },
          MINIMAL_PACKET()
        ),
      /cannot modify immutable/
    );
  });
});
