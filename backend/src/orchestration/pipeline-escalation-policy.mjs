export function buildPipelineEscalationCommand({ task_id, from_profile, to_profile, reason_codes = [], evidence = {} } = {}) {
  if (!task_id) throw new Error("task_id is required");
  if (!to_profile) throw new Error("to_profile is required");
  return {
    action: "pipeline_escalation",
    idempotency_key: ["pipeline_escalation", task_id, from_profile || "unknown", to_profile, ...reason_codes].join(":"),
    payload: {
      task_id,
      from_profile: from_profile || null,
      to_profile,
      reason_codes: Array.isArray(reason_codes) ? reason_codes : [],
      evidence: evidence && typeof evidence === "object" ? evidence : {},
    },
  };
}

export function shouldEscalatePipeline({ current_profile, detected_risk, conflicts = [], stale_artifacts = [] } = {}) {
  const reason_codes = [];
  if (detected_risk && detected_risk !== current_profile) reason_codes.push("risk_increased");
  if (conflicts.length > 0) reason_codes.push("conflict_detected");
  if (stale_artifacts.length > 0) reason_codes.push("artifact_stale");
  return { escalate: reason_codes.length > 0, reason_codes };
}
