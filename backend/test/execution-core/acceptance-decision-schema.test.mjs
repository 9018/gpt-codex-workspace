import test from "node:test";
import assert from "node:assert/strict";

import { createAcceptanceDecision, evaluateEvidence, ACCEPTANCE_DECISIONS } from "../../src/execution-core/acceptance-decision-schema.mjs";

test("requires run_id", () => {
  assert.throws(() => createAcceptanceDecision({ decision: "accepted" }), /run_id is required/);
});

test("requires valid decision", () => {
  assert.throws(
    () => createAcceptanceDecision({ run_id: "r1", decision: "unknown" }),
    /decision must be one of/
  );
});

test("creates decision with defaults", () => {
  const d = createAcceptanceDecision({ run_id: "r1", decision: "accepted" });
  assert.ok(d.id.startsWith("decision_"));
  assert.equal(d.run_id, "r1");
  assert.equal(d.decision, "accepted");
  assert.deepEqual(d.missing_items, []);
});

// ---------------------------------------------------------------------------
// evaluateEvidence
// ---------------------------------------------------------------------------

test("rejects null evidence", () => {
  const result = evaluateEvidence({ operationKind: "code_change", evidenceBundle: null });
  assert.equal(result.decision, "rejected");
});

test("code_change requires commit and changed_files", () => {
  const result = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: {
      repository: {},
      commands: [{ command: "test" }],
      provider_claims: [],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "repair_required");
  assert.ok(result.missing_items.includes("commit_sha"));
  assert.ok(result.missing_items.includes("changed_files"));
});

test("code_change accepts with complete evidence", () => {
  const result = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: {
      repository: { commit_sha: "abc123", changed_files: ["src/main.mjs"] },
      commands: [{ command: "npm test", exit_code: 0 }],
      provider_claims: [],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "accepted");
});

test("test_only does not require commit", () => {
  const result = evaluateEvidence({
    operationKind: "test_only",
    evidenceBundle: {
      repository: {},
      commands: [{ command: "npm test", exit_code: 0 }],
      provider_claims: [],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "accepted", "test_only without commit should be accepted");
});

test("test_only requires test commands", () => {
  const result = evaluateEvidence({
    operationKind: "test_only",
    evidenceBundle: {
      repository: {},
      commands: [],
      provider_claims: [],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "repair_required");
  assert.ok(result.missing_items.includes("test_commands"));
});

test("question with no mutation is accepted", () => {
  const result = evaluateEvidence({
    operationKind: "question",
    evidenceBundle: {
      repository: {},
      commands: [],
      provider_claims: [],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "accepted");
});

test("rejects unreconciled provider claims", () => {
  const result = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: {
      repository: { commit_sha: "abc123", changed_files: ["src/main.mjs"] },
      commands: [{ command: "npm test", exit_code: 0 }],
      provider_claims: [{ id: "c1", statement: "Unverified claim" }],
      rejected_claims: [],
    },
  });
  assert.equal(result.decision, "repair_required");
  assert.ok(result.missing_items.includes("unreconciled_claims"));
});

test("flags rejected claims", () => {
  const result = evaluateEvidence({
    operationKind: "code_change",
    evidenceBundle: {
      repository: { commit_sha: "abc123", changed_files: ["src/main.mjs"] },
      commands: [{ command: "npm test", exit_code: 0 }],
      provider_claims: [],
      rejected_claims: [{ id: "r1", statement: "Fake test result" }],
    },
  });
  assert.equal(result.decision, "repair_required");
  assert.equal(result.rejected_claims.length, 1);
});
