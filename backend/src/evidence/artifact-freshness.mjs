// @ts-check
/**
 * Artifact Freshness — evaluates whether agent artifacts are still valid
 * against the current context digest and Git HEAD.
 */

/**
 * Create a blocker finding.
 * @param {string} code
 * @param {string} message
 * @param {object} [evidence]
 * @returns {object}
 */
function blocker(code, message, evidence = {}) {
  return {
    severity: "blocker",
    code,
    message,
    source: "artifact_freshness",
    evidence,
  };
}

/**
 * Evaluate artifact freshness.
 * @param {object} options
 * @param {object|null} options.artifact - The artifact envelope to check.
 * @param {string} [options.expectedContextDigest] - The expected task context digest.
 * @param {string} [options.expectedHead] - The expected Git HEAD.
 * @param {object} [options.expectedInputs] - Expected input artifact digests.
 * @returns {{ passed: boolean, findings: Array<object> }}
 */
export function evaluateArtifactFreshness({
  artifact,
  expectedContextDigest,
  expectedHead,
  expectedInputs = {},
}) {
  const findings = [];

  if (!artifact) {
    return {
      passed: false,
      findings: [
        blocker("artifact_missing", "Required artifact is missing."),
      ],
    };
  }

  if (
    expectedContextDigest &&
    artifact.context_digest !== expectedContextDigest
  ) {
    findings.push(
      blocker("artifact_context_stale", "Artifact was produced for a different task context.", {
        expected: expectedContextDigest,
        actual: artifact.context_digest,
      })
    );
  }

  const actualHead =
    artifact.git?.output_head || artifact.git?.input_head || null;
  if (expectedHead && actualHead !== expectedHead) {
    findings.push(
      blocker("artifact_head_stale", "Artifact was produced for a different Git HEAD.", {
        expected: expectedHead,
        actual: actualHead,
      })
    );
  }

  for (const [name, digest] of Object.entries(expectedInputs)) {
    if (artifact.input_artifact_digests?.[name] !== digest) {
      findings.push(
        blocker(
          "artifact_input_stale",
          `Artifact input "${name}" does not match.`,
          {
            expected: digest,
            actual: artifact.input_artifact_digests?.[name] || null,
          }
        )
      );
    }
  }

  return { passed: findings.length === 0, findings };
}

/**
 * Assert that an artifact is fresh. Throws on stale.
 * @param {object} options
 * @returns {boolean}
 * @throws {Error}
 */
export function assertFreshArtifact(options) {
  const { passed, findings } = evaluateArtifactFreshness(options);
  if (!passed) {
    const error = new Error("artifact_stale");
    error.code = "artifact_stale";
    error.findings = findings;
    throw error;
  }
  return true;
}

export const BLOCKER_CODES = Object.freeze([
  "artifact_missing",
  "artifact_context_stale",
  "artifact_head_stale",
  "artifact_input_stale",
  "artifact_schema_invalid",
]);
