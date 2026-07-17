export function normalizeExecutionEvidence(value = {}, { provider = null, attemptId = null } = {}) {
  const status = ["completed", "failed", "timed_out"].includes(value.status) ? value.status : "failed";
  return {
    schema_version: 1,
    provider,
    attempt_id: attemptId,
    status,
    summary: String(value.summary || ""),
    changed_files: Array.isArray(value.changed_files) ? [...value.changed_files] : [],
    tests: Array.isArray(value.tests) ? structuredClone(value.tests) : value.tests ?? [],
    commit: value.commit || null,
    remote_head: value.remote_head || null,
    verification: value.verification && typeof value.verification === "object"
      ? structuredClone(value.verification)
      : { passed: status === "completed", commands: [] },
    raw: structuredClone(value),
  };
}
