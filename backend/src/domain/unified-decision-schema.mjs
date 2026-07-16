export const UNIFIED_DECISION_SCHEMA_VERSION = 2;

export function hasDecisionRevision(value) {
  return value !== undefined && value !== null && value !== "";
}

export function normalizeDecisionRevision(previousRevision, fallback) {
  if (Number.isInteger(previousRevision) && previousRevision >= 0) return previousRevision + 1;
  if (hasDecisionRevision(previousRevision)) return previousRevision;
  return fallback;
}
