/**
 * supervisor-review-revision.test.mjs — Tests for buildReviewRevision
 *
 * @module test/supervisor-review/supervisor-review-revision
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildReviewRevision } from "../../src/supervisor-review/supervisor-review-revision.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseFacts = {
  run: { id: "run_1", version: 3, acceptance_contract_digest: "acc123" },
  checkpoint: { id: "cp_1", digest: "cp_digest_1" },
  repository: {
    base_sha: "abc123",
    head_sha: "def456",
    diff_digest: "diff_abc",
    dirty_paths: ["b.mjs", "a.mjs"],
  },
  contextManifest: { digest: "ctx_digest_1" },
  supervisorPlan: { version: 2 },
};

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("review revision is deterministic for identical facts", () => {
  assert.deepEqual(
    buildReviewRevision(baseFacts),
    buildReviewRevision(baseFacts)
  );
});

test("review revision is deterministic across repeated calls", () => {
  const a = buildReviewRevision(baseFacts);
  const b = buildReviewRevision(baseFacts);
  assert.equal(a.id, b.id);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Fact change invalidates revision
// ---------------------------------------------------------------------------

test("diff change invalidates revision", () => {
  const a = buildReviewRevision(baseFacts);
  const b = buildReviewRevision({
    ...baseFacts,
    repository: { ...baseFacts.repository, diff_digest: "diff_xyz" },
  });
  assert.notEqual(a.id, b.id);
});

test("head sha change invalidates revision", () => {
  const a = buildReviewRevision(baseFacts);
  const b = buildReviewRevision({
    ...baseFacts,
    repository: { ...baseFacts.repository, head_sha: "xyz789" },
  });
  assert.notEqual(a.id, b.id);
});

test("plan version change invalidates revision", () => {
  const a = buildReviewRevision(baseFacts);
  const b = buildReviewRevision({
    ...baseFacts,
    supervisorPlan: { version: 3 },
  });
  assert.notEqual(a.id, b.id);
});

test("checkpoint digest change invalidates revision", () => {
  const a = buildReviewRevision(baseFacts);
  const b = buildReviewRevision({
    ...baseFacts,
    checkpoint: { id: "cp_2", digest: "cp_digest_2" },
  });
  assert.notEqual(a.id, b.id);
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("revision payload has expected fields", () => {
  const rev = buildReviewRevision(baseFacts);
  assert.equal(typeof rev.id, "string");
  assert.equal(rev.id.length, 64); // sha256 hex
  assert.equal(rev.run_id, "run_1");
  assert.equal(rev.run_version, 3);
  assert.equal(rev.checkpoint_id, "cp_1");
  assert.equal(rev.checkpoint_digest, "cp_digest_1");
  assert.equal(rev.base_sha, "abc123");
  assert.equal(rev.head_sha, "def456");
  assert.equal(rev.diff_digest, "diff_abc");
  assert.deepEqual(rev.dirty_paths, ["a.mjs", "b.mjs"]); // sorted
  assert.equal(rev.context_digest, "ctx_digest_1");
  assert.equal(rev.plan_revision, 2);
  assert.equal(rev.acceptance_contract_digest, "acc123");
});
