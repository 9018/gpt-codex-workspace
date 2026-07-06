import { AGENT_ROLE_ENUM, LEGACY_AGENT_ROLE_ALIASES, normalizeContractRole } from "./agent-artifact-contract.mjs";

/**
 * subagent-policy.mjs — Agent pipeline role definitions, defaults, and backends.
 *
 * P0-MA4: Product default multi-agent pipeline.
 * Main pipeline: context_curator -> planner -> builder -> verifier -> reviewer -> integrator -> finalizer
 * Recovery branch: repairer (not part of main pipeline, triggered on failure)
 *
 * Legacy role aliases provide backward compatibility for older role names.
 * Each role can have a different execution backend.
 */

// -- Product default pipeline -------------------------------------------------
// The main-line roles executed in order for every task.
// repairer is intentionally excluded -- it is a recovery branch.
export const DEFAULT_AGENT_PIPELINE = Object.freeze([
  "context_curator",
  "planner",
  "builder",
  "verifier",
  "reviewer",
  "integrator",
  "finalizer",
]);

/** Recovery branch role -- not part of the default main pipeline. */
export const REPAIRER_ROLE = "repairer";

/** All pipeline-inclusive roles (main + recovery). */
export const ALL_PIPELINE_ROLES = Object.freeze([...DEFAULT_AGENT_PIPELINE, REPAIRER_ROLE]);

// -- Legacy role mapping -------------------------------------------------------
// Maps old role names used in older goal/task configs to new canonical roles.
// This ensures backward compatibility for tasks that specify old role names.
export const LEGACY_ROLE_MAPPING = Object.freeze({
  implementer: "builder",
  tester: "verifier",
  architect: "planner",
  escalation_judge: "reviewer",
});

// -- Role-to-backend default mapping -------------------------------------------
// P0-05: Product-default executable backends.
//
// builder/repairer:   codex_exec (real agent execution via Codex CLI)
// verifier/reviewer:  local_command (deterministic shell command execution)
// context_curator/planner:  null auto-artifact (prepared from task metadata)
// integrator/finalizer:     null auto-artifact (auto-completed from result evidence)
//
// Override per role via GPTWORK_AGENT_ROLE_BACKENDS env var:
//   GPTWORK_AGENT_ROLE_BACKENDS=verifier=null,reviewer=null
//   GPTWORK_AGENT_ROLE_BACKENDS=verifier=local_command,reviewer=local_command
//
// Configuration examples:
//   # Global backend for all roles
//   GPTWORK_AGENT_BACKEND=local_command
//
//   # Per-role backends
//   GPTWORK_AGENT_ROLE_BACKENDS=builder=codex_exec,verifier=local_command,reviewer=local_command
//
//   # Per-role local commands (default: role-agnostic agentLocalCommand)
//   GPTWORK_AGENT_ROLE_COMMANDS=verifier=npm test -- --ci,reviewer=node scripts/review.mjs
//
// Evidence provenance:
//   - codex_exec:  Backend: codex_exec,  Evidence: real agent execution via Codex CLI
//   - local_command: Backend: local_command,  Evidence: deterministic shell command
//   - null:        Backend: null,  Evidence: auto_artifact (no external commands)
export const DEFAULT_AGENT_BACKEND_BY_ROLE = Object.freeze({
  context_curator: "null",
  planner: "null",
  builder: "codex_exec",
  // P0-05: verifier and reviewer now default to local_command for deterministic execution
  verifier: "local_command",
  reviewer: "local_command",
  // integrator and finalizer remain null (auto-artifact from result evidence)
  integrator: "null",
  finalizer: "null",
  repairer: "codex_exec",
});

export const AGENT_ROLES = AGENT_ROLE_ENUM;
export const LEGACY_AGENT_ROLES = Object.freeze(Object.keys(LEGACY_AGENT_ROLE_ALIASES).filter((role) => role !== "analyst"));
export const ACCEPTED_AGENT_ROLES = Object.freeze([...AGENT_ROLE_ENUM, ...LEGACY_AGENT_ROLES]);

const ROLE_SET = new Set(ACCEPTED_AGENT_ROLES);

export function isSupportedAgentRole(role) {
  return ROLE_SET.has(role);
}

export function normalizeAgentRole(role, fallback = "builder") {
  const value = role || fallback;
  if (!ROLE_SET.has(value)) throw new Error(`Unsupported agent role: ${value}`);
  return normalizeContractRole(value, fallback);
}

export function validateAgentRoles(roles = DEFAULT_AGENT_PIPELINE) {
  const list = Array.isArray(roles) && roles.length > 0 ? roles : DEFAULT_AGENT_PIPELINE;
  for (const role of list) normalizeAgentRole(role);
  return list;
}

/**
 * Resolve the default backend for a given pipeline role.
 * P0-05: builder -> "codex_exec", verifier/reviewer -> "local_command",
 * others -> "null" (auto-artifact) unless overridden.
 *
 * @param {string} role - Agent role
 * @param {object} [overrides={}] - Optional role->backend override map
 * @returns {string} Backend identifier
 */
export function resolveDefaultBackendForRole(role, overrides = {}) {
  const normalized = normalizeContractRole(role, "builder");
  if (overrides && typeof overrides === "object" && overrides[normalized]) {
    return overrides[normalized];
  }
  return DEFAULT_AGENT_BACKEND_BY_ROLE[normalized] || "null";
}

/**
 * Describe a role's backend with evidence provenance for diagnostics and review packets.
 * Returns a structured description including the backend id, execution semantic,
 * null reason (if applicable), evidence source, and a human-readable doc string.
 *
 * @param {string} role - Agent role
 * @param {object} [config={}] - Runtime config with potential overrides
 * @returns {{ backend: string, semantic: string, null_reason: string|null, evidence_source: string, doc: string, overridden: boolean }}
 */
export function describeRoleBackend(role, config = {}) {
  const normalized = normalizeContractRole(role, "builder");
  const configBackend = config.agentRoleBackends?.[normalized]
    || config.agentBackendByRole?.[normalized];
  const globalBackend = config.agentBackend || config.agentBackendDefault;
  const resolvedBackend = configBackend || globalBackend || DEFAULT_AGENT_BACKEND_BY_ROLE[normalized] || "codex_exec";
  const overridden = Boolean(configBackend || globalBackend);

  let semantic, nullReason, evidenceSource, doc;

  if (resolvedBackend === "codex_exec") {
    semantic = "real";
    nullReason = null;
    evidenceSource = "codex_exec (real agent execution)";
    doc = "Actual Codex execution for code changes.";
  } else if (resolvedBackend === "local_command") {
    semantic = "real";
    nullReason = null;
    evidenceSource = "local_command (deterministic shell command)";
    doc = "Deterministic local command execution.";
  } else {
    // null backend
    semantic = "auto_artifact";
    nullReason = "auto_artifact";
    evidenceSource = "null (auto_artifact — no external commands executed)";
    doc = "Auto-completed from task/result evidence.";
    // Check for specific role documentation
    const roleDocs = {
      context_curator: "Context bundle prepared from task metadata.",
      planner: "Plan determined from context/prompt files.",
      integrator: "Auto-completed from integration result evidence.",
      finalizer: "Auto-completed from task result evidence.",
    };
    if (roleDocs[normalized]) doc = roleDocs[normalized];
  }

  return {
    role: normalized,
    backend: resolvedBackend,
    semantic,
    null_reason: nullReason,
    evidence_source: evidenceSource,
    doc,
    overridden,
    config_source: configBackend ? "agentRoleBackends" : globalBackend ? "agentBackend" : "default",
  };
}

/**
 * Check if a role is a recovery branch role (only repairer).
 *
 * @param {string} role
 * @returns {boolean}
 */
export function isRecoveryBranchRole(role) {
  return normalizeContractRole(role, "builder") === REPAIRER_ROLE;
}

/**
 * Map a legacy role name to its canonical pipeline role.
 *
 * @param {string} role - Role name (may be legacy or canonical)
 * @returns {string} Canonical role name
 */
export function mapLegacyRole(role) {
  if (!role) return "builder";
  const trimmed = String(role).trim();
  if (ROLE_SET.has(trimmed)) return normalizeContractRole(trimmed);
  return LEGACY_ROLE_MAPPING[trimmed] || normalizeContractRole(trimmed);
}
