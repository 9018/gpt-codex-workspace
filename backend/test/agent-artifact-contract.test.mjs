import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_ROLE_ENUM,
  ARTIFACT_SCHEMA,
  getRunArtifactPaths,
  mapLegacyArtifactsToContract,
  normalizeContractRole,
  validateAgentArtifactContract,
} from "../src/agent-artifact-contract.mjs";

test("agent artifact contract exposes the canonical G2 role enum", () => {
  assert.deepEqual(AGENT_ROLE_ENUM, [
    "context_curator",
    "planner",
    "builder",
    "verifier",
    "repairer",
    "reviewer",
    "finalizer",
    "integrator",
  ]);
});

test("agent artifact contract normalizes legacy delivery roles to canonical roles", () => {
  assert.equal(normalizeContractRole("implementer"), "builder");
  assert.equal(normalizeContractRole("tester"), "verifier");
  assert.equal(normalizeContractRole("analyst"), "context_curator");
  assert.equal(normalizeContractRole("architect"), "planner");
  assert.equal(normalizeContractRole("escalation_judge"), "reviewer");
  assert.equal(normalizeContractRole("builder"), "builder");
  assert.throws(() => normalizeContractRole("unknown_role"), /unsupported agent role/i);
});

test("run artifact paths preserve existing goal result and context bundle locations", () => {
  const paths = getRunArtifactPaths({ goalId: "goal_123", taskId: "task_456", runId: "run_789" });

  assert.equal(paths.goal_dir, ".gptwork/goals/goal_123");
  assert.equal(paths.result_json, ".gptwork/goals/goal_123/result.json");
  assert.equal(paths.result_md, ".gptwork/goals/goal_123/result.md");
  assert.equal(paths.context_bundle_md, ".gptwork/goals/goal_123/context.bundle.md");
  assert.equal(paths.context_retrieval_json, ".gptwork/goals/goal_123/context.retrieval.json");
  assert.equal(paths.context_manifest_json, ".gptwork/goals/goal_123/context.manifest.json");
  assert.equal(paths.reviewer_decision_json, ".gptwork/goals/goal_123/reviewer_decision.json");
  assert.equal(paths.run_dir, ".gptwork/runs/task_456/run_789");
  assert.equal(paths.run_json, ".gptwork/runs/task_456/run_789/run.json");
  assert.equal(paths.artifact_manifest_json, ".gptwork/runs/task_456/run_789/artifacts.json");
});

test("legacy result/context artifacts map to standard artifact records", () => {
  const artifacts = mapLegacyArtifactsToContract({
    goalId: "goal_1",
    taskId: "task_1",
    runId: "run_1",
    result: { status: "completed", reviewer_decision: { status: "accepted", passed: true } },
    hasContextBundle: true,
    hasContextRetrieval: true,
    hasContextManifest: true,
  });

  assert.deepEqual(
    artifacts.map((artifact) => [artifact.kind, artifact.role, artifact.path]),
    [
      ["context_bundle", "context_curator", ".gptwork/goals/goal_1/context.bundle.md"],
      ["context_retrieval", "context_curator", ".gptwork/goals/goal_1/context.retrieval.json"],
      ["context_manifest", "context_curator", ".gptwork/goals/goal_1/context.manifest.json"],
      ["result", "finalizer", ".gptwork/goals/goal_1/result.json"],
      ["reviewer_decision", "reviewer", ".gptwork/goals/goal_1/reviewer_decision.json"],
    ],
  );
});

test("validateAgentArtifactContract blocks completion when required artifacts are missing", () => {
  const validation = validateAgentArtifactContract({
    role: "finalizer",
    status: "completed",
    summary: "finished",
    output_artifacts: [],
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missing_artifacts, ["result"]);
  assert.equal(validation.findings[0].code, "artifact_result_missing");
});

test("validateAgentArtifactContract accepts existing result.json contract as finalizer artifact", () => {
  const validation = validateAgentArtifactContract({
    role: "finalizer",
    status: "completed",
    summary: "finished",
    output_artifacts: [".gptwork/goals/goal_1/result.json"],
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.missing_artifacts, []);
});

test("artifact schema documents required artifact kinds by role", () => {
  assert.deepEqual(ARTIFACT_SCHEMA.required_by_role.finalizer, ["result"]);
  assert.deepEqual(ARTIFACT_SCHEMA.required_by_role.context_curator, ["context_bundle"]);
  assert.ok(ARTIFACT_SCHEMA.kinds.context_manifest.extensions.includes(".json"));
  assert.ok(ARTIFACT_SCHEMA.kinds.result.extensions.includes(".json"));
});


test("pipeline v2 rejects a required artifact produced for stale context", () => {
  const run = {
    role: "verifier",
    status: "completed",
    require_fresh_artifacts: true,
    input_context_digest: "sha256:current",
    expected_head: "head-current",
    output_artifacts: [{
      kind: "verification",
      path: ".gptwork/goals/g/verification.json",
      context_digest: "sha256:old",
      git: { input_head: "head-current", output_head: "head-current" },
      input_artifact_digests: {}
    }]
  };
  const result = validateAgentArtifactContract(run);
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => finding.code === "artifact_context_stale"));
});

test("pipeline v2 accepts a fresh required artifact", () => {
  const run = {
    role: "reviewer",
    status: "completed",
    require_fresh_artifacts: true,
    input_context_digest: "sha256:current",
    expected_head: "head-current",
    output_artifacts: [{
      kind: "reviewer_decision",
      path: ".gptwork/goals/g/reviewer_decision.json",
      context_digest: "sha256:current",
      git: { input_head: "head-current", output_head: "head-current" },
      input_artifact_digests: {}
    }]
  };
  const result = validateAgentArtifactContract(run);
  assert.equal(result.valid, true);
});
