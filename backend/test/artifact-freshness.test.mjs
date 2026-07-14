import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateArtifactFreshness,
  assertFreshArtifact,
  BLOCKER_CODES,
} from "../src/evidence/artifact-freshness.mjs";

describe("evaluateArtifactFreshness", () => {
  it("fails when artifact is missing", () => {
    const { passed, findings } = evaluateArtifactFreshness({ artifact: null });
    assert.equal(passed, false);
    assert.ok(findings.some((f) => f.code === "artifact_missing"));
  });

  it("passes when artifact matches context", () => {
    const artifact = { context_digest: "sha256:abc", git: { output_head: "abc123" } };
    const result = evaluateArtifactFreshness({
      artifact,
      expectedContextDigest: "sha256:abc",
      expectedHead: "abc123",
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.findings, []);
  });

  it("flags stale context digest", () => {
    const artifact = { context_digest: "sha256:old", git: { output_head: "abc123" } };
    const { passed, findings } = evaluateArtifactFreshness({
      artifact,
      expectedContextDigest: "sha256:new",
    });
    assert.equal(passed, false);
    assert.ok(findings.some((f) => f.code === "artifact_context_stale"));
  });

  it("flags stale git head", () => {
    const artifact = { context_digest: "sha256:match", git: { output_head: "old_head" } };
    const { passed, findings } = evaluateArtifactFreshness({
      artifact,
      expectedContextDigest: "sha256:match",
      expectedHead: "new_head",
    });
    assert.equal(passed, false);
    assert.ok(findings.some((f) => f.code === "artifact_head_stale"));
  });

  it("flags stale input digests", () => {
    const artifact = {
      context_digest: "sha256:abc",
      input_artifact_digests: { plan: "sha256:old_plan" },
    };
    const { passed, findings } = evaluateArtifactFreshness({
      artifact,
      expectedContextDigest: "sha256:abc",
      expectedInputs: { plan: "sha256:new_plan" },
    });
    assert.equal(passed, false);
    assert.ok(findings.some((f) => f.code === "artifact_input_stale"));
  });
});

describe("assertFreshArtifact", () => {
  it("throws with stale artifact", () => {
    assert.throws(
      () =>
        assertFreshArtifact({
          artifact: null,
          expectedContextDigest: "sha256:abc",
        }),
      /artifact_stale/
    );
  });
});
