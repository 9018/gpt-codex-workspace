export const AGENT_ROLES = [
  "planner",
  "architect",
  "implementer",
  "tester",
  "reviewer",
  "finalizer",
  "repairer",
  "escalation_judge",
];

export const DEFAULT_AGENT_PIPELINE = ["planner", "implementer", "tester", "reviewer", "finalizer"];

const ROLE_SET = new Set(AGENT_ROLES);

export function isSupportedAgentRole(role) {
  return ROLE_SET.has(role);
}

export function normalizeAgentRole(role, fallback = "implementer") {
  const value = role || fallback;
  if (ROLE_SET.has(value)) return value;
  throw new Error(`Unsupported agent role: ${value}`);
}

export function validateAgentRoles(roles = DEFAULT_AGENT_PIPELINE) {
  const list = Array.isArray(roles) && roles.length > 0 ? roles : DEFAULT_AGENT_PIPELINE;
  for (const role of list) normalizeAgentRole(role);
  return list;
}
