import { PIPELINE_PROFILE_ROLES, PIPELINE_PROFILE_SCHEMA_VERSION, PIPELINE_PROFILES } from "./pipeline-profile-schema.mjs";

function normalizeRiskLevel(task = {}) {
  const raw = task.risk_level ?? task.riskLevel ?? task.pipeline_risk_level ?? task.pipelineRiskLevel;
  const value = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["readonly", "read_only", "no_change", "diagnostic"].includes(value)) return "readonly";
  if (PIPELINE_PROFILES.includes(value)) return value;
  if (task.deploy === true || task.cross_repo === true || task.has_historical_failures === true) return "high";
  if (Array.isArray(task.changed_files) && task.changed_files.length > 5) return "medium";
  return "low";
}

function buildShards(task = {}, riskLevel) {
  if (riskLevel !== "high") return [];
  const files = Array.isArray(task.changed_files) ? task.changed_files : [];
  const sourceFiles = files.filter((file) => !String(file).includes("test"));
  const testFiles = files.filter((file) => String(file).includes("test"));
  return [
    { key: "implementation", owner_role: "builder", files: sourceFiles },
    { key: "tests", owner_role: "test_designer", files: testFiles },
  ];
}

export function selectPipelineProfile({ task = {}, facts = {} } = {}) {
  const riskLevel = normalizeRiskLevel({ ...facts, ...task });
  const roles = [...PIPELINE_PROFILE_ROLES[riskLevel]];
  const shards = buildShards(task, riskLevel);

  return {
    schema_version: PIPELINE_PROFILE_SCHEMA_VERSION,
    selected_profile: riskLevel,
    risk_level: riskLevel,
    strategy: riskLevel === "high" ? "fanout_join" : "sequential",
    roles,
    shards,
    dependencies: roles.slice(1).map((role, index) => ({ from: roles[index], to: role })),
    join_policy: riskLevel === "high"
      ? { type: "all_completed", conflict_policy: "integration_command" }
      : { type: "sequential" },
    escalation_rules: ["risk_increased", "conflict_detected", "artifact_stale"],
    reason_codes: [task.risk_level ? "explicit_risk_level" : "derived_risk_level"],
  };
}
