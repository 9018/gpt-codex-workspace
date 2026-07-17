const REVIEWER_FORBIDDEN_INPUT_KINDS = new Set(["builder_self_conclusion", "builder_claim", "builder_summary_only"]);

export function assertRoleIndependence({ role, input_artifacts = [] } = {}) {
  if (role !== "reviewer") return { valid: true, findings: [] };
  const forbidden = (Array.isArray(input_artifacts) ? input_artifacts : [])
    .filter((artifact) => REVIEWER_FORBIDDEN_INPUT_KINDS.has(artifact?.kind || artifact));
  if (forbidden.length === 0) return { valid: true, findings: [] };
  const error = new Error("reviewer_independence_violation: reviewer must read diff, contract, and test evidence instead of builder self conclusions");
  error.code = "reviewer_independence_violation";
  error.findings = forbidden.map((artifact) => ({ code: "reviewer_independence_violation", artifact_kind: artifact?.kind || artifact }));
  throw error;
}

export function checkFileOwnershipConflicts(shards = []) {
  const owners = new Map();
  const conflicts = [];
  for (const shard of Array.isArray(shards) ? shards : []) {
    for (const file of Array.isArray(shard.files) ? shard.files : []) {
      if (owners.has(file) && owners.get(file) !== shard.key) {
        conflicts.push({ file, first_owner: owners.get(file), second_owner: shard.key });
      } else {
        owners.set(file, shard.key);
      }
    }
  }
  return { valid: conflicts.length === 0, conflicts };
}
