/**
 * checkpoint-correction-builder.mjs — Build correction instructions for checkpoint feedback.
 *
 * When a checkpoint verdict is "send_correction" or "run_deterministic_repair",
 * this module builds the instruction text to send back to the TUI.
 *
 * @module checkpoint-correction-builder
 */

/**
 * Create the correction builder.
 *
 * @returns {object} Correction builder API
 */
export function createCheckpointCorrectionBuilder() {
  /**
   * Build a correction instruction based on missing or failed items.
   *
   * @param {object} options
   * @param {object[]} options.missingItems - Items that need attention
   * @param {object[]} [options.rejectedClaims] - Claims that were rejected
   * @param {string} [options.goalText] - The original goal text
   * @param {number} [options.correctionCycle] - Which correction cycle this is
   * @returns {{ instruction: string, type: string }}
   */
  function buildCorrection({ missingItems = [], rejectedClaims = [], goalText = "", correctionCycle = 0 } = {}) {
    const parts = [];

    if (goalText) {
      parts.push(`Goal: ${goalText}`);
    }

    if (missingItems.length > 0) {
      parts.push(`\nMissing items:\n${missingItems.map((item) => `  - ${item.description || item}`).join("\n")}`);
    }

    if (rejectedClaims.length > 0) {
      parts.push(`\nRejected claims:\n${rejectedClaims.map((claim) => `  - ${claim}`).join("\n")}`);
    }

    parts.push(`\nPlease address the above items and continue working.`);

    const instruction = parts.join("\n");
    return {
      instruction,
      type: correctionCycle > 2 ? "detailed_correction" : "simple_correction",
    };
  }

  /**
   * Build a deterministic repair command for a known failure pattern.
   *
   * @param {object} options
   * @param {string} options.failureCode - Known failure code
   * @param {object} [options.context] - Additional repair context
   * @returns {{ instruction: string, type: string }|null}
   */
  function buildDeterministicRepair({ failureCode, context = {} } = {}) {
    switch (failureCode) {
      case "missing_commit":
        return { instruction: "git add -A && git commit -m 'checkpoint repair: auto-commit pending changes'", type: "git_commit" };
      case "missing_test":
        return { instruction: "Run the relevant test suite for the current changes.", type: "run_tests" };
      case "unreconciled_claims":
        return { instruction: `Reconcile the following claims with concrete evidence: ${context.claims?.join(", ") || "unknown"}`, type: "reconcile_claims" };
      default:
        return null;
    }
  }

  return { buildCorrection, buildDeterministicRepair };
}
