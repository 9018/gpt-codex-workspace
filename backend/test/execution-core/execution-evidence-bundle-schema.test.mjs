import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceBundle, reconcileProviderClaims } from "../../src/execution-core/execution-evidence-bundle-schema.mjs";

test("createEvidenceBundle creates bundle with defaults", () => {
  const bundle = createEvidenceBundle({ run_id: "run_001" });

  assert.ok(bundle.id.startsWith("evidence_bundle_"));
  assert.equal(bundle.run_id, "run_001");
  assert.equal(bundle.schema_version, 2);
  assert.deepEqual(bundle.attempt_ids, []);
  assert.deepEqual(bundle.repository.base_sha, null);
  assert.equal(bundle.tests.executed, false);
  assert.equal(bundle.tests.passed, true);
  assert.deepEqual(bundle.commands, []);
  assert.deepEqual(bundle.provider_claims, []);
  assert.deepEqual(bundle.verified_facts, []);
  assert.deepEqual(bundle.rejected_claims, []);
  assert.deepEqual(bundle.completeness.required_items, []);
  assert.deepEqual(bundle.completeness.present_items, []);
  assert.deepEqual(bundle.completeness.missing_items, []);
});

test("createEvidenceBundle preserves explicit fields", () => {
  const bundle = createEvidenceBundle({
    id: "bundle_001",
    run_id: "run_001",
    attempt_ids: ["attempt_001"],
    repository: {
      base_sha: "abc123",
      head_sha: "def456",
      changed_files: ["src/main.mjs"],
      commit_sha: "def456",
    },
    commands: [{ command: "npm test", exit_code: 0 }],
    tests: { executed: true, passed: true, total: 10, passed_count: 10 },
    provider_claims: [{ id: "c1", statement: "All tests pass", evidence_type: "command_exit_code" }],
  });

  assert.equal(bundle.id, "bundle_001");
  assert.deepEqual(bundle.attempt_ids, ["attempt_001"]);
  assert.equal(bundle.repository.base_sha, "abc123");
  assert.equal(bundle.repository.commit_sha, "def456");
  assert.deepEqual(bundle.repository.changed_files, ["src/main.mjs"]);
  assert.equal(bundle.commands[0].command, "npm test");
  assert.equal(bundle.tests.total, 10);
});

// ---------------------------------------------------------------------------
// reconcileProviderClaims
// ---------------------------------------------------------------------------

test("reconcileProviderClaims moves unverifiable claims to rejected_claims", () => {
  const bundle = createEvidenceBundle({
    run_id: "run_001",
    provider_claims: [
      { id: "c1", statement: "All 884 tests passed", evidence_type: "command_exit_code" },
      { id: "c2", statement: "Fixed the bug" },
    ],
  });

  const reconciled = reconcileProviderClaims(bundle);

  assert.equal(reconciled.verified_facts.length, 0,
    "Should not verify claims without corroborating command evidence");

  assert.equal(reconciled.rejected_claims.length, 2,
    "Both claims should be rejected");
  assert.ok(reconciled.rejected_claims[0].reason.includes("No corroborating"),
    `Expected rejection reason about missing evidence, got: ${reconciled.rejected_claims[0].reason}`);
});

test("reconcileProviderClaims verifies claims with corroborating command evidence", () => {
  const bundle = createEvidenceBundle({
    run_id: "run_001",
    commands: [{ command: "npm test", exit_code: 0 }],
    provider_claims: [
      {
        id: "c1",
        statement: "Tests pass",
        evidence_type: "command_exit_code",
        command_keywords: ["test"],
        expected_exit_code: 0,
      },
    ],
  });

  const reconciled = reconcileProviderClaims(bundle);

  assert.equal(reconciled.verified_facts.length, 1,
    "Claim with corroborating command should be verified");
  assert.equal(reconciled.rejected_claims.length, 0,
    "No claims should be rejected");
  assert.equal(reconciled.verified_facts[0].claim_id, "c1");
});

test("reconcileProviderClaims verifies commit claims", () => {
  const bundle = createEvidenceBundle({
    run_id: "run_001",
    repository: { commit_sha: "abc123def456" },
    provider_claims: [
      {
        id: "c1",
        statement: "Changes committed at abc123def456",
        evidence_type: "commit_sha",
        commit_sha: "abc123def456",
      },
    ],
  });

  const reconciled = reconcileProviderClaims(bundle);

  assert.equal(reconciled.verified_facts.length, 1);
  assert.equal(reconciled.verified_facts[0].claim_id, "c1");
});

test("reconcileProviderClaims rejects commit claims with mismatched sha", () => {
  const bundle = createEvidenceBundle({
    run_id: "run_001",
    repository: { commit_sha: "actual_sha" },
    provider_claims: [
      {
        id: "c1",
        statement: "Changes committed at wrong_sha",
        evidence_type: "commit_sha",
        commit_sha: "wrong_sha",
      },
    ],
  });

  const reconciled = reconcileProviderClaims(bundle);

  assert.equal(reconciled.verified_facts.length, 0);
  assert.equal(reconciled.rejected_claims.length, 1);
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test("created bundle fields are deep-cloned from input", () => {
  const commands = [{ command: "test" }];
  const bundle = createEvidenceBundle({ run_id: "run_001", commands });

  commands[0].command = "mutated";

  assert.equal(bundle.commands[0].command, "test");
});
