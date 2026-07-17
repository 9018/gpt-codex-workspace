/**
 * canonical-acceptance-adapter.mjs — Canonical Acceptance Decision adapter.
 *
 * Wraps the existing acceptance/closure/unified decision systems into a
 * canonical AcceptanceDecision that is the sole source of truth for
 * whether an ExecutionRun should complete.
 *
 * Per the plan (section 12):
 *   Terminal Evidence → Canonical Acceptance Decision → Progression Command
 *
 * @module canonical-acceptance-adapter
 */

/**
 * Create the canonical acceptance adapter.
 *
 * @param {object} deps
 * @param {object} [deps.unifiedDecisionService] - Existing unified decision system
 * @param {object} [deps.progressionCommandBuilder] - For building commands
 * @param {object} [deps.stateStore] - For reading task/goal state
 * @returns {object} Canonical acceptance API
 */
export function createCanonicalAcceptanceAdapter(deps = {}) {
  /**
   * Evaluate a run's evidence and produce a canonical AcceptanceDecision.
   * This wraps the existing acceptance/closure/unified decision systems
   * so that the execution-core always goes through one path.
   *
   * @param {object} options
   * @param {object} options.run - ExecutionRun
   * @param {object} [options.intent] - ExecutionIntent
   * @param {object} [options.evidence] - Evidence bundle
   * @returns {Promise<{ decision: string, summary: string, id?: string, missing_items?: string[], rejected_claims?: string[], canonical: boolean }>}
   */
  async function evaluate({ run, intent = null, evidence = null } = {}) {
    // Step 1: Check if we can use the unified decision system
    if (deps.unifiedDecisionService && run.task_id) {
      try {
        const unifiedDecision = await deps.unifiedDecisionService.evaluate({
          taskId: run.task_id,
          goalId: run.goal_id,
          evidence,
          runState: run.state,
        });

        if (unifiedDecision?.decision === "accept" || unifiedDecision?.decision === "complete") {
          return {
            decision: "accepted",
            summary: unifiedDecision.summary || "Canonical acceptance via unified decision",
            id: unifiedDecision.id || `canonical_${run.id}`,
            canonical: true,
          };
        }

        if (unifiedDecision?.decision === "repair") {
          return {
            decision: "repair_required",
            summary: unifiedDecision.summary || "Repair required per unified decision",
            missing_items: unifiedDecision.missing_items || [],
            canonical: true,
          };
        }

        if (unifiedDecision?.decision === "review") {
          return {
            decision: "review_required",
            summary: unifiedDecision.summary || "Review required per unified decision",
            canonical: true,
          };
        }
      } catch {
        // Unified decision unavailable; fall through to local evaluation
      }
    }

    // Step 2: Local evaluation (when unified decision unavailable)
    if (!evidence) {
      return { decision: "repair_required", summary: "No evidence collected", canonical: false };
    }

    // Check for missing items
    const missingItems = [];
    if (evidence.missing_items) {
      missingItems.push(...evidence.missing_items);
    }

    // Check for unreconciled provider claims
    const providerClaims = evidence.provider_claims || [];
    if (providerClaims.length > 0) {
      missingItems.push("unreconciled_claims");
    }

    // Check for test results
    const tests = evidence.tests || [];
    if (tests.length > 0 && tests.some((t) => t.status === "failed")) {
      return {
        decision: "repair_required",
        summary: "Some tests failed",
        missing_items: ["test_failures"],
        canonical: false,
      };
    }

    if (missingItems.length > 0) {
      return {
        decision: "repair_required",
        summary: `Missing evidence items: ${missingItems.join(", ")}`,
        missing_items: missingItems,
        canonical: false,
      };
    }

    return { decision: "accepted", summary: "Evidence meets acceptance criteria", canonical: true };
  }

  return { evaluate };
}
