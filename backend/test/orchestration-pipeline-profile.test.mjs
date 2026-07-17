import test from "node:test";
import assert from "node:assert/strict";

import { validatePipelineProfile } from "../src/orchestration/pipeline-profile-schema.mjs";
import { selectPipelineProfile } from "../src/orchestration/pipeline-selector.mjs";
import { planDynamicTeam } from "../src/orchestration/dynamic-team-planner.mjs";
import { buildFanoutJoinPlan } from "../src/orchestration/fanout-join-controller.mjs";
import { assertRoleIndependence } from "../src/orchestration/role-independence-policy.mjs";
import { buildPipelineEscalationCommand } from "../src/orchestration/pipeline-escalation-policy.mjs";
import { recordAgentValueTelemetry } from "../src/orchestration/agent-value-telemetry.mjs";
import { validateArtifactProvenance } from "../src/orchestration/artifact-provenance-validator.mjs";

test("adaptive orchestration selects a complete low-risk pipeline profile", () => {
  const profile = selectPipelineProfile({ task: { id: "t_low", risk_level: "low" } });

  assert.equal(profile.schema_version, 1);
  assert.equal(profile.selected_profile, "low");
  assert.equal(profile.risk_level, "low");
  assert.deepEqual(profile.roles, ["builder", "verifier"]);
  assert.equal(profile.strategy, "sequential");
  assert.deepEqual(validatePipelineProfile(profile).valid, true);
});

test("adaptive orchestration plans high-risk fanout without creating agent runs", () => {
  const profile = selectPipelineProfile({
    task: { id: "t_high", risk_level: "high", changed_files: ["src/a.mjs", "test/a.test.mjs"] },
  });
  const dag = planDynamicTeam(profile, { task_id: "t_high" });
  const fanout = buildFanoutJoinPlan(profile, { workstream_id: "ws_high", phase: "build" });

  assert.equal(profile.strategy, "fanout_join");
  assert.ok(profile.shards.length >= 2);
  assert.ok(dag.nodes.some((node) => node.role === "test_designer"));
  assert.ok(dag.nodes.some((node) => node.role === "reviewer"));
  assert.equal(dag.creates_agent_runs, false);
  assert.equal(fanout.shard_nodes.length, profile.shards.length);
  assert.equal(fanout.join_node.join_condition, "all_completed");
});

test("adaptive orchestration enforces reviewer independence and provenance", () => {
  assert.throws(
    () => assertRoleIndependence({ role: "reviewer", input_artifacts: [{ kind: "builder_self_conclusion" }] }),
    /reviewer_independence_violation/,
  );

  const valid = validateArtifactProvenance({
    artifact: {
      producer_role: "builder",
      attempt_id: "attempt_1",
      input_digest: "sha256:input",
      repo_base_commit: "abc123",
      task_revision: 3,
      acceptance_contract_digest: "sha256:contract",
    },
    expected: {
      input_digest: "sha256:input",
      repo_base_commit: "abc123",
      task_revision: 3,
      acceptance_contract_digest: "sha256:contract",
    },
  });

  assert.equal(valid.valid, true);
  assert.deepEqual(valid.findings, []);
});

test("adaptive orchestration builds escalation commands and telemetry records", () => {
  const command = buildPipelineEscalationCommand({
    task_id: "t_escalate",
    from_profile: "low",
    to_profile: "medium",
    reason_codes: ["risk_increased"],
  });
  const telemetry = recordAgentValueTelemetry({ role: "verifier", latency_ms: 50, finding_count: 2, prevented_failure: true });

  assert.equal(command.action, "pipeline_escalation");
  assert.equal(command.payload.to_profile, "medium");
  assert.equal(telemetry.role, "verifier");
  assert.equal(telemetry.prevented_failure, true);
});
