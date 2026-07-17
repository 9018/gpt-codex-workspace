/**
 * operation-profile-registry.mjs — Profile-based acceptance rules per operation kind.
 *
 * Each operation kind declares what evidence is required, what is optional,
 * and what invariants must hold (e.g., test_only must not require commit).
 *
 * @module operation-profile-registry
 */

/**
 * Profile descriptor for a single operation kind.
 * @typedef {object} OperationProfile
 * @property {string}    operationKind
 * @property {string[]}  requiredEvidence - Evidence that MUST be present
 * @property {string[]}  optionalEvidence - Evidence that MAY be present
 * @property {boolean}   requiresCommit
 * @property {boolean}   requiresIntegration
 * @property {boolean}   requiresWorktree
 * @property {boolean}   allowsMutation
 * @property {string[]}  forbiddenStates - Run states that must not be reached
 */

/** @type {Object<string, OperationProfile>} */
const PROFILES = {
  code_change: {
    operationKind: "code_change",
    requiredEvidence: ["changed_files", "commit_sha", "commands"],
    optionalEvidence: ["test_results", "integration_sha"],
    requiresCommit: true,
    requiresIntegration: true,
    requiresWorktree: true,
    allowsMutation: true,
    forbiddenStates: [],
  },
  docs_change: {
    operationKind: "docs_change",
    requiredEvidence: ["changed_files", "commit_sha"],
    optionalEvidence: ["docs_checks"],
    requiresCommit: true,
    requiresIntegration: false,
    requiresWorktree: true,
    allowsMutation: true,
    forbiddenStates: ["waiting_for_integration"],
  },
  test_only: {
    operationKind: "test_only",
    requiredEvidence: ["commands"],
    optionalEvidence: ["test_results", "coverage"],
    requiresCommit: false,
    requiresIntegration: false,
    requiresWorktree: false,
    allowsMutation: false,
    forbiddenStates: [],
  },
  question: {
    operationKind: "question",
    requiredEvidence: [],
    optionalEvidence: ["answer", "source_refs"],
    requiresCommit: false,
    requiresIntegration: false,
    requiresWorktree: false,
    allowsMutation: false,
    forbiddenStates: [],
  },
  diagnostic: {
    operationKind: "diagnostic",
    requiredEvidence: [],
    optionalEvidence: ["report"],
    requiresCommit: false,
    requiresIntegration: false,
    requiresWorktree: false,
    allowsMutation: false,
    forbiddenStates: [],
  },
  code_review: {
    operationKind: "code_review",
    requiredEvidence: ["review_scope"],
    optionalEvidence: ["findings"],
    requiresCommit: false,
    requiresIntegration: false,
    requiresWorktree: false,
    allowsMutation: false,
    forbiddenStates: [],
  },
  planning: {
    operationKind: "planning",
    requiredEvidence: ["ordered_plan"],
    optionalEvidence: ["target_files", "acceptance_criteria"],
    requiresCommit: false,
    requiresIntegration: false,
    requiresWorktree: false,
    allowsMutation: false,
    forbiddenStates: [],
  },
};

/**
 * Get the profile for a given operation kind.
 *
 * @param {string} operationKind
 * @returns {OperationProfile|undefined}
 */
export function getProfile(operationKind) {
  return PROFILES[operationKind] ? { ...PROFILES[operationKind] } : undefined;
}

/**
 * Check if an operation kind is known.
 *
 * @param {string} operationKind
 * @returns {boolean}
 */
export function hasProfile(operationKind) {
  return operationKind in PROFILES;
}

/**
 * List all registered operation kinds.
 *
 * @returns {string[]}
 */
export function listProfiles() {
  return Object.keys(PROFILES);
}

/**
 * Get profile requirements summary for an operation.
 *
 * @param {string} operationKind
 * @returns {object|null}
 */
export function getProfileRequirements(operationKind) {
  const profile = PROFILES[operationKind];
  if (!profile) return null;

  return {
    requires_commit: profile.requiresCommit,
    requires_integration: profile.requiresIntegration,
    requires_worktree: profile.requiresWorktree,
    allows_mutation: profile.allowsMutation,
    required_evidence: [...profile.requiredEvidence],
    forbidden_states: [...profile.forbiddenStates],
  };
}
