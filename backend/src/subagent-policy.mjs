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
// builder/repairer use codex_exec for actual code changes.
// Other roles use deterministic local/null service to write artifact records.
export const DEFAULT_AGENT_BACKEND_BY_ROLE = Object.freeze({
  context_curator: "null",
  planner: "null",
  builder: "codex_exec",
  verifier: "null",
  reviewer: "null",
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
 * builder -> "codex_exec", others -> "null" unless overridden.
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
