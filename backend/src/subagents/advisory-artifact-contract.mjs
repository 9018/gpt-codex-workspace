// @ts-check
/**
 * Advisory Artifact Contract — validation for advisory role outputs.
 */

export const ADVISORY_ROLE_ENUM = Object.freeze([
  "explorer",
  "architect",
  "test_analyst",
]);

const ADVISORY_ARTIFACT_KINDS = Object.freeze(
  new Set([
    "exploration_analysis",
    "architecture_analysis",
    "test_analysis",
  ])
);

/**
 * Validate an advisory artifact structure.
 * @param {any} artifact
 * @returns {true}
 */
export function validateAdvisoryArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("advisory_artifact: must be an object");
  }
  if (!ADVISORY_ARTIFACT_KINDS.has(artifact.kind)) {
    throw new Error(
      `advisory_artifact: kind must be one of ${[...ADVISORY_ARTIFACT_KINDS].join(", ")}`
    );
  }
  if (typeof artifact.context_digest !== "string") {
    throw new Error("advisory_artifact: context_digest must be a string");
  }
  return true;
}

/**
 * Check whether a role is advisory (non-blocking).
 * @param {string} role
 * @returns {boolean}
 */
export function isAdvisoryRole(role) {
  return ADVISORY_ROLE_ENUM.includes(role);
}
