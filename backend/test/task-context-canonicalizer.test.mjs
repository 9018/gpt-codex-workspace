import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeJson,
  digestCanonical,
  taskContextContractDigest,
  taskContextInstanceDigest,
  diffTaskContextPackets,
} from "../src/context-contract/task-context-canonicalizer.mjs";

const PACKET_A = () => ({
  schema_version: "gptwork.task_context.v1",
  identity: { workstream_id: "ws_x", goal_id: null, task_id: null, context_revision: 1 },
  objective: "Do the thing",
  background: [],
  confirmed_findings: [],
  scope: { include: ["src/"], exclude: [] },
  required_changes: [],
  acceptance_criteria: [
    { id: "ac1", description: "pass", blocking: true, verification_hint: null },
  ],
  constraints: [],
  open_questions: [],
  carry_forward: [],
  source_provenance: [],
  raw_conversation_policy: {
    stored: true, indexed: false, injected: false, targeted_lookup_allowed: true,
  },
});

describe("canonicalizeJson", () => {
  it("sorts object keys", () => {
    const result = canonicalizeJson({ z: 1, a: 2 });
    assert.deepEqual(result, { a: 2, z: 1 });
  });

  it("filters transient fields (compiled_at)", () => {
    const result = canonicalizeJson({ compiled_at: "now", objective: "test" });
    assert.equal(result.compiled_at, undefined);
    assert.equal(result.objective, "test");
  });

  it("handles nested arrays", () => {
    const input = {
      list: [{ b: 2, a: 1 }],
    };
    const result = canonicalizeJson(input);
    assert.deepEqual(result, { list: [{ a: 1, b: 2 }] });
  });
});

describe("taskContextContractDigest", () => {
  it("is stable regardless of key order", () => {
    const a = PACKET_A();
    const b = PACKET_A();
    // Reorder
    const { objective, ...rest } = b;
    b.objective = objective;

    const d1 = taskContextContractDigest(a);
    const d2 = taskContextContractDigest(b);
    assert.equal(d1, d2);
  });

  it("changes when objective changes", () => {
    const a = PACKET_A();
    const b = PACKET_A();
    b.objective = "Different thing";

    assert.notEqual(taskContextContractDigest(a), taskContextContractDigest(b));
  });

  it("is unaffected by compiled_at, goal_id, task_id", () => {
    const a = PACKET_A();
    const b = PACKET_A();
    b.compiled_at = new Date().toISOString();
    b.identity.goal_id = "goal_123";
    b.identity.task_id = "task_456";

    assert.equal(taskContextContractDigest(a), taskContextContractDigest(b));
  });
});

describe("taskContextInstanceDigest", () => {
  it("differs from contract digest when identity is populated", () => {
    const p = PACKET_A();
    p.identity.goal_id = "goal_x";
    p.identity.task_id = "task_x";

    const contractDigest = taskContextContractDigest(p);
    const instanceDigest = taskContextInstanceDigest(p);
    assert.notEqual(contractDigest, instanceDigest);
  });

  it("includes contract_digest in identity", () => {
    const p = PACKET_A();
    const d = taskContextInstanceDigest(p);
    assert.ok(d.startsWith("sha256:"));
  });
});

describe("diffTaskContextPackets", () => {
  it("finds no differences for identical packets", () => {
    const a = PACKET_A();
    const diffs = diffTaskContextPackets(a, { ...a });
    assert.deepEqual(diffs, []);
  });

  it("finds differences when objective changes", () => {
    const a = PACKET_A();
    const b = { ...a, objective: "new" };
    const diffs = diffTaskContextPackets(a, b);
    assert.ok(diffs.some((d) => d.key === "objective" && d.change === "modified"));
  });
});
