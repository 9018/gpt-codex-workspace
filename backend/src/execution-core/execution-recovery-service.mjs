/**
 * execution-recovery-service.mjs — Classified recovery engine.
 *
 * When a provider attempt fails, this service classifies the failure and
 * executes a targeted recovery action.  The goal is always to repair the
 * specific gap rather than retrying the entire run.
 *
 * Recovery action rules:
 * - native_session_binding_missing → rebind session (same provider)
 * - result_json_missing → recollect evidence only
 * - commit_missing → deterministic commit repair
 * - worktree_dirty_unexpected → classify & clean
 * - context_stale → rebuild context
 * - provider_unavailable → failover to another provider
 * - integration_conflict → create integration repair node
 * - attempt_budget_exhausted → supervisor_required checkpoint
 * - unknown → supervisor_required
 *
 * @module execution-recovery-service
 */

/**
 * Classify a failure into a structured recovery decision.
 *
 * @param {object} failure
 * @param {string} failure.code
 * @param {string} [failure.provider]
 * @param {object} [failure.detail]
 * @returns {object} { classification, automatic_action, retry_scope, resumable }
 */
export function classifyFailure(failure) {
  const code = failure?.code || "unknown";

  const taxonomy = {
    // Provider-level failures
    provider_unavailable: {
      classification: "provider_unavailable",
      automatic_action: "failover",
      retry_scope: "new_attempt",
      resumable: true,
    },
    native_session_binding_missing: {
      classification: "session_missing",
      automatic_action: "rebind_session",
      retry_scope: "same_provider",
      resumable: true,
    },
    codex_transport_404: {
      classification: "provider_unavailable",
      automatic_action: "failover",
      retry_scope: "new_attempt",
      resumable: true,
    },
    pty_unavailable: {
      classification: "session_missing",
      automatic_action: "failover",
      retry_scope: "new_attempt",
      resumable: true,
    },

    // Evidence-level failures
    result_json_missing: {
      classification: "evidence_missing",
      automatic_action: "recollect_evidence",
      retry_scope: "evidence_only",
      resumable: true,
    },
    commit_missing: {
      classification: "evidence_missing",
      automatic_action: "deterministic_commit",
      retry_scope: "delivery_only",
      resumable: true,
    },
    test_evidence_missing: {
      classification: "evidence_missing",
      automatic_action: "rerun_verification",
      retry_scope: "verification_only",
      resumable: true,
    },

    // Repository failures
    worktree_dirty_unexpected: {
      classification: "workspace_dirty",
      automatic_action: "classify_and_clean_worktree",
      retry_scope: "workspace_only",
      resumable: true,
    },
    integration_conflict: {
      classification: "integration_conflict",
      automatic_action: "create_integration_repair_node",
      retry_scope: "integration_only",
      resumable: true,
    },

    // Context failures
    context_stale: {
      classification: "context_stale",
      automatic_action: "rebuild_context",
      retry_scope: "context_only",
      resumable: true,
    },

    // Budget / unknown
    attempt_budget_exhausted: {
      classification: "budget_exhausted",
      automatic_action: "supervisor_required",
      retry_scope: "none",
      resumable: false,
    },
    execution_timeout: {
      classification: "timeout",
      automatic_action: "supervisor_required",
      retry_scope: "none",
      resumable: false,
    },
    unknown: {
      classification: "unknown",
      automatic_action: "supervisor_required",
      retry_scope: "none",
      resumable: false,
    },
  };

  return taxonomy[code] || taxonomy.unknown;
}

/**
 * Create the recovery service.
 *
 * @param {object} deps
 * @param {object} [deps.providerRegistry] - For provider failover
 * @param {object} [deps.attemptStore] - For creating new attempts
 * @param {object} [deps.contextService] - For rebuilding context
 * @param {object} [deps.workspaceService] - For worktree cleanup
 * @returns {object} { recover }
 */
export function createRecoveryService(deps = {}) {
  /**
   * Attempt to recover from a failure.
   *
   * @param {object} options
   * @param {object} options.run - Current run state
   * @param {object} options.failure - Classified failure
   * @param {object} options.intent - Original execution intent
   * @param {number} options.attemptNumber - Current attempt number
   * @param {number} options.maxAttempts - Maximum allowed attempts
   * @returns {Promise<{ action: string, resumable: boolean, next_provider?: string, next_attempt?: boolean }>}
   */
  async function recover({ run, failure, intent, attemptNumber, maxAttempts }) {
    const classification = classifyFailure(failure);

    // If budget exhausted, no automatic recovery
    if (classification.retry_scope === "none") {
      return { action: "supervisor_required", resumable: false };
    }

    // If we've exceeded max attempts, force supervisor review
    if (attemptNumber >= maxAttempts) {
      return { action: "supervisor_required", resumable: false };
    }

    switch (classification.automatic_action) {
      case "failover": {
        // Try the other provider
        const currentProvider = failure.provider || "codex_exec";
        const nextProvider = currentProvider === "codex_exec" ? "codex_tui" : "codex_exec";

        // Check availability
        const available = deps.providerRegistry
          ? await deps.providerRegistry.isAvailable(nextProvider)
          : true;

        if (!available) {
          return { action: "supervisor_required", resumable: false };
        }

        return {
          action: "failover",
          resumable: true,
          next_provider: nextProvider,
          next_attempt: true,
        };
      }

      case "recollect_evidence": {
        // Simply re-collect the evidence from the existing provider session
        return { action: "recollect_evidence", resumable: true, next_attempt: false };
      }

      case "deterministic_commit": {
        // Perform a deterministic commit of the changes
        return { action: "deterministic_commit", resumable: true, next_attempt: false };
      }

      case "rebuild_context": {
        // Rebuild the execution context
        if (deps.contextService) {
          await deps.contextService.build({ run });
        }
        return { action: "context_rebuilt", resumable: true, next_attempt: false };
      }

      case "rebind_session": {
        // Try to rebind the native session
        return { action: "rebind_session", resumable: true, next_attempt: true };
      }

      case "rerun_verification": {
        // Re-run the verification commands only
        return { action: "rerun_verification", resumable: true, next_attempt: false };
      }

      case "classify_and_clean_worktree": {
        // Clean up the worktree
        if (deps.workspaceService) {
          await deps.workspaceService.cleanup({ run });
        }
        return { action: "worktree_cleaned", resumable: true, next_attempt: false };
      }

      case "create_integration_repair_node": {
        // Create a repair attempt for the integration conflict
        return { action: "integration_repair", resumable: true, next_attempt: true };
      }

      default:
        return { action: "supervisor_required", resumable: false };
    }
  }

  return { recover, classifyFailure };
}
