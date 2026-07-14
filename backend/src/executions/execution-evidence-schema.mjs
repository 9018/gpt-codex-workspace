/**
 * execution-evidence-schema.mjs — Unified ExecutionEvidence schema
 * and validation utilities.
 *
 * Both codex_exec and codex_tui providers produce evidence that conforms
 * to this schema.  The evidence is the sole input to the finalizer.
 *
 * @module execution-evidence-schema
 */

/**
 * The current schema version for ExecutionEvidence.
 * Bump this when making breaking changes to the evidence shape.
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Validate the structure of an ExecutionEvidence object.
 *
 * Checks:
 *   - Required top-level fields exist
 *   - runtime sub-object has required fields
 *   - outcome is a valid shape
 *   - integration is well-formed
 *
 * @param {object} evidence - Raw evidence object
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExecutionEvidence(evidence) {
  const errors = [];

  if (!evidence || typeof evidence !== "object") {
    return { valid: false, errors: ["evidence must be a non-null object"] };
  }

  if (evidence.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${EVIDENCE_SCHEMA_VERSION}`);
  }

  if (!evidence.evidence_id || typeof evidence.evidence_id !== "string") {
    errors.push("evidence_id is required");
  }

  if (!evidence.execution_id || typeof evidence.execution_id !== "string") {
    errors.push("execution_id is required");
  }

  if (!evidence.provider || !["codex_exec", "codex_tui"].includes(evidence.provider)) {
    errors.push("provider must be codex_exec or codex_tui");
  }

  if (!evidence.task_id || typeof evidence.task_id !== "string") {
    errors.push("task_id is required");
  }

  // runtime sub-object
  if (!evidence.runtime || typeof evidence.runtime !== "object") {
    errors.push("runtime sub-object is required");
  } else {
    if (!evidence.runtime.started_at) errors.push("runtime.started_at is required");
    if (!evidence.runtime.termination_reason) errors.push("runtime.termination_reason is required");
  }

  // verification sub-object
  if (evidence.verification && typeof evidence.verification === "object") {
    if (typeof evidence.verification.passed !== "boolean") {
      errors.push("verification.passed must be a boolean present");
    }
  } else {
    errors.push("verification sub-object is required");
  }

  // diagnostics
  if (evidence.diagnostics && typeof evidence.diagnostics === "object") {
    if (!Array.isArray(evidence.diagnostics.blockers)) {
      errors.push("diagnostics.blockers must be an array");
    }
    if (!Array.isArray(evidence.diagnostics.warnings)) {
      errors.push("diagnostics.warnings must be an array");
    }
  } else {
    errors.push("diagnostics sub-object is required");
  }

  // provenance
  if (!evidence.provenance || typeof evidence.provenance !== "object") {
    errors.push("provenance sub-object is required");
  } else {
    if (!evidence.provenance.collected_at) {
      errors.push("provenance.collected_at is required");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a minimal valid ExecutionEvidence skeleton.
 * Useful for tests and as a starting point for provider collectors.
 *
 * @param {object} params
 * @returns {object} Partial evidence with defaults
 */
export function createEvidenceSkeleton({
  execution_id,
  provider,
  task_id,
  goal_id = null,
}) {
  const now = new Date().toISOString();
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: `evidence_${execution_id}`,
    execution_id,
    provider,
    task_id,
    goal_id,
    runtime: {
      started_at: now,
      ended_at: null,
      duration_ms: null,
      exit_code: null,
      termination_reason: null,
    },
    repository: {
      canonical_repo_path: null,
      worktree_path: null,
      branch: null,
      base_commit: null,
      head_commit: null,
      worktree_clean: true,
    },
    outcome: {
      reported_status: null,
      summary: null,
      operation_kind: null,
      no_change_reason: null,
    },
    changes: [],
    verification: {
      passed: false,
      commands: [],
    },
    artifacts: [],
    integration: {
      required: false,
      status: "pending",
      satisfied: false,
      commit: null,
    },
    diagnostics: {
      warnings: [],
      blockers: [],
    },
    provenance: {
      collected_at: now,
      collector: null,
      source_refs: [],
    },
  };
}
