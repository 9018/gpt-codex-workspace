import { AGENT_ROLE_ENUM, LEGACY_AGENT_ROLE_ALIASES, normalizeContractRole } from "./agent-artifact-contract.mjs";

export const AGENT_ROLES = AGENT_ROLE_ENUM;
export const LEGACY_AGENT_ROLES = Object.freeze(Object.keys(LEGACY_AGENT_ROLE_ALIASES).filter((role) => role !== "analyst"));
export const ACCEPTED_AGENT_ROLES = Object.freeze([...AGENT_ROLE_ENUM, ...LEGACY_AGENT_ROLES]);

export const DEFAULT_AGENT_PIPELINE = ["planner", "implementer", "tester", "reviewer", "finalizer"];

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
