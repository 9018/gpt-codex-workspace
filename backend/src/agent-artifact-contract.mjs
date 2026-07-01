export const AGENT_ROLE_ENUM = Object.freeze([
  "context_curator",
  "planner",
  "builder",
  "verifier",
  "repairer",
  "reviewer",
  "finalizer",
  "integrator",
]);

export const LEGACY_AGENT_ROLE_ALIASES = Object.freeze({
  analyst: "context_curator",
  architect: "planner",
  implementer: "builder",
  tester: "verifier",
  test: "verifier",
  qa: "verifier",
  verification: "verifier",
  escalation_judge: "reviewer",
  escalation_judgment: "reviewer",
  "escalation-judge": "reviewer",
  "escalation-judgment": "reviewer",
});

export const ARTIFACT_SCHEMA = Object.freeze({
  version: "gptwork.agent_artifact.v1",
  roles: AGENT_ROLE_ENUM,
  kinds: Object.freeze({
    context_bundle: Object.freeze({ extensions: Object.freeze([".md"]), legacy_paths: Object.freeze(["context.bundle.md"]) }),
    context_retrieval: Object.freeze({ extensions: Object.freeze([".json"]), legacy_paths: Object.freeze(["context.retrieval.json"]) }),
    context_manifest: Object.freeze({ extensions: Object.freeze([".json"]), legacy_paths: Object.freeze(["context.manifest.json"]) }),
    plan: Object.freeze({ extensions: Object.freeze([".md", ".json"]) }),
    change_summary: Object.freeze({ extensions: Object.freeze([".md", ".json", ".diff", ".patch"]) }),
    verification: Object.freeze({ extensions: Object.freeze([".json", ".md", ".log", ".txt"]) }),
    repair: Object.freeze({ extensions: Object.freeze([".json", ".md"]) }),
    reviewer_decision: Object.freeze({ extensions: Object.freeze([".json", ".md"]), legacy_paths: Object.freeze(["reviewer_decision.json"]) }),
    result: Object.freeze({ extensions: Object.freeze([".json", ".md"]), legacy_paths: Object.freeze(["result.json", "result.md"]) }),
    integration: Object.freeze({ extensions: Object.freeze([".json", ".md", ".log"]) }),
  }),
  required_by_role: Object.freeze({
    context_curator: Object.freeze(["context_bundle"]),
    planner: Object.freeze(["plan"]),
    builder: Object.freeze(["change_summary"]),
    verifier: Object.freeze(["verification"]),
    repairer: Object.freeze(["repair"]),
    reviewer: Object.freeze(["reviewer_decision"]),
    finalizer: Object.freeze(["result"]),
    integrator: Object.freeze(["integration"]),
  }),
});

const ROLE_SET = new Set(AGENT_ROLE_ENUM);

export function isCanonicalAgentRole(role) {
  return ROLE_SET.has(role);
}

export function normalizeContractRole(role, fallback = "builder") {
  const value = role || fallback;
  if (ROLE_SET.has(value)) return value;
  const normalized = LEGACY_AGENT_ROLE_ALIASES[value];
  if (normalized) return normalized;
  throw new Error(`Unsupported agent role: ${value}`);
}

export function getRunArtifactPaths({ goalId, taskId, runId } = {}) {
  const goalDir = `.gptwork/goals/${goalId || "unknown_goal"}`;
  const runDir = `.gptwork/runs/${taskId || "unknown_task"}/${runId || "latest"}`;
  return {
    goal_dir: goalDir,
    result_json: `${goalDir}/result.json`,
    result_md: `${goalDir}/result.md`,
    context_bundle_md: `${goalDir}/context.bundle.md`,
    context_retrieval_json: `${goalDir}/context.retrieval.json`,
    context_manifest_json: `${goalDir}/context.manifest.json`,
    reviewer_decision_json: `${goalDir}/reviewer_decision.json`,
    run_dir: runDir,
    run_json: `${runDir}/run.json`,
    stdout_log: `${runDir}/stdout.log`,
    stderr_log: `${runDir}/stderr.log`,
    artifact_manifest_json: `${runDir}/artifacts.json`,
  };
}

export function artifactRecord({ kind, role, path, required = false, legacy = false, present = true, metadata = {} } = {}) {
  return {
    schema_version: ARTIFACT_SCHEMA.version,
    kind,
    role: normalizeContractRole(role),
    path,
    required: required === true,
    legacy: legacy === true,
    present: present !== false,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
}

export function mapLegacyArtifactsToContract({ goalId, taskId, runId, result, hasContextBundle = false, hasContextRetrieval = false, hasContextManifest = false } = {}) {
  const paths = getRunArtifactPaths({ goalId, taskId, runId });
  const artifacts = [];

  if (hasContextBundle) {
    artifacts.push(artifactRecord({ kind: "context_bundle", role: "context_curator", path: paths.context_bundle_md, required: true, legacy: true }));
  }

  if (hasContextRetrieval) {
    artifacts.push(artifactRecord({ kind: "context_retrieval", role: "context_curator", path: paths.context_retrieval_json, legacy: true }));
  }

  if (hasContextManifest) {
    artifacts.push(artifactRecord({ kind: "context_manifest", role: "context_curator", path: paths.context_manifest_json, legacy: true }));
  }

  if (result && typeof result === "object") {
    artifacts.push(artifactRecord({
      kind: "result",
      role: "finalizer",
      path: paths.result_json,
      required: true,
      legacy: true,
      metadata: { status: result.status || null },
    }));
    if (result.reviewer_decision && typeof result.reviewer_decision === "object") {
      artifacts.push(artifactRecord({
        kind: "reviewer_decision",
        role: "reviewer",
        path: paths.reviewer_decision_json,
        required: true,
        legacy: true,
        metadata: { status: result.reviewer_decision.status || result.reviewer_decision.decision?.status || null },
      }));
    }
  }

  return artifacts;
}

function artifactKindForValue(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const kind = value.kind || value.type || value.artifact_kind;
    if (kind && ARTIFACT_SCHEMA.kinds[kind]) return kind;
    if (value.path) return artifactKindForValue(value.path);
    if (value.decision || value.passed !== undefined || value.status) return "reviewer_decision";
    return null;
  }
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  if (lower.endsWith("context.bundle.md")) return "context_bundle";
  if (lower.endsWith("context.retrieval.json")) return "context_retrieval";
  if (lower.endsWith("context.manifest.json")) return "context_manifest";
  if (lower.endsWith("result.json") || lower.endsWith("result.md")) return "result";
  if (lower.includes("reviewer_decision") || lower.includes("review-decision") || lower.includes("review_decision")) return "reviewer_decision";
  if (lower.includes("verification") || lower.includes("test") || lower.endsWith("verification.json")) return "verification";
  if (lower.includes("plan")) return "plan";
  if (lower.includes("repair")) return "repair";
  if (lower.includes("integration") || lower.includes("merge")) return "integration";
  if (lower.includes("change") || lower.includes("patch") || lower.includes("diff") || lower.includes("implementation") || lower.includes("code")) return "change_summary";
  return null;
}

export function hasArtifactKind(artifacts = [], kind) {
  return (Array.isArray(artifacts) ? artifacts : []).some((artifact) => artifactKindForValue(artifact) === kind);
}

export function validateAgentArtifactContract(agentRun = {}) {
  const role = normalizeContractRole(agentRun.role);
  const required = Array.from(ARTIFACT_SCHEMA.required_by_role[role] || []);
  const outputArtifacts = Array.isArray(agentRun.output_artifacts) ? agentRun.output_artifacts : [];
  const inputArtifacts = Array.isArray(agentRun.input_artifacts) ? agentRun.input_artifacts : [];
  const artifacts = [...inputArtifacts, ...outputArtifacts];
  const missingArtifacts = required.filter((kind) => !hasArtifactKind(artifacts, kind));
  const findings = missingArtifacts.map((kind) => ({
    severity: "blocker",
    code: `artifact_${kind}_missing`,
    message: `${role} completed without required ${kind} artifact`,
    role,
    artifact_kind: kind,
  }));

  return {
    valid: missingArtifacts.length === 0,
    role,
    required_artifacts: required,
    missing_artifacts: missingArtifacts,
    findings,
  };
}
