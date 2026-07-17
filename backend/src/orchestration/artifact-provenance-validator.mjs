const REQUIRED_PROVENANCE_FIELDS = Object.freeze([
  "producer_role",
  "attempt_id",
  "input_digest",
  "repo_base_commit",
  "task_revision",
  "acceptance_contract_digest",
]);

export function validateArtifactProvenance({ artifact = {}, expected = {} } = {}) {
  const findings = [];
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    if (artifact[field] === undefined || artifact[field] === null || artifact[field] === "") {
      findings.push({ code: "artifact_provenance_missing", field });
    }
  }
  for (const field of ["input_digest", "repo_base_commit", "task_revision", "acceptance_contract_digest"]) {
    if (expected[field] !== undefined && artifact[field] !== expected[field]) {
      findings.push({ code: "artifact_provenance_stale", field, expected: expected[field], actual: artifact[field] });
    }
  }
  return { valid: findings.length === 0, findings };
}

export function assertArtifactProvenance(args = {}) {
  const result = validateArtifactProvenance(args);
  if (result.valid) return result;
  const error = new Error("artifact_provenance_invalid");
  error.code = "artifact_provenance_invalid";
  error.findings = result.findings;
  throw error;
}
