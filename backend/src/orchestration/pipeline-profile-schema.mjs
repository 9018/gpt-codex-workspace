export const PIPELINE_PROFILE_SCHEMA_VERSION = 1;

export const PIPELINE_PROFILES = Object.freeze(["readonly", "low", "medium", "high"]);

export const PIPELINE_PROFILE_ROLES = Object.freeze({
  readonly: Object.freeze(["verifier"]),
  low: Object.freeze(["builder", "verifier"]),
  medium: Object.freeze(["planner", "builder", "verifier", "reviewer"]),
  high: Object.freeze(["context_curator", "planner", "builder", "test_designer", "verifier", "reviewer", "integrator", "finalizer"]),
});

export function validatePipelineProfile(profile = {}) {
  const findings = [];
  if (profile.schema_version !== PIPELINE_PROFILE_SCHEMA_VERSION) findings.push("schema_version");
  if (!PIPELINE_PROFILES.includes(profile.selected_profile)) findings.push("selected_profile");
  if (!PIPELINE_PROFILES.includes(profile.risk_level)) findings.push("risk_level");
  if (typeof profile.strategy !== "string" || !profile.strategy) findings.push("strategy");
  if (!Array.isArray(profile.roles) || profile.roles.length === 0) findings.push("roles");
  if (!Array.isArray(profile.shards)) findings.push("shards");
  if (!Array.isArray(profile.dependencies)) findings.push("dependencies");
  if (typeof profile.join_policy !== "object" || profile.join_policy === null) findings.push("join_policy");
  if (!Array.isArray(profile.escalation_rules)) findings.push("escalation_rules");
  if (!Array.isArray(profile.reason_codes)) findings.push("reason_codes");

  return {
    valid: findings.length === 0,
    findings,
  };
}
