/**
 * execution-evidence-normalizer.mjs — Normalize raw execution output
 * into a canonical ExecutionEvidence object.
 *
 * The normalizer:
 *   - Converts changed_files (string[]) to changes[] with status
 *   - Normalizes verification commands
 *   - Detects dirty worktree and missing commits
 *   - Checks artifact freshness
 *   - Does NOT decide task status
 *
 * @module execution-evidence-normalizer
 */
/**
 * @deprecated Wave 10R — 旧 execution 路径。
 * 新代码应使用 execution-core/ 模块：
 *   ExecutionRunService → execution-core/execution-run-service.mjs
 *   ExecutionRunStore → execution-core/execution-run-store.mjs
 * 将在下次大版本中移除。
 */


import { randomUUID } from "node:crypto";
import { EVIDENCE_SCHEMA_VERSION, createEvidenceSkeleton, validateExecutionEvidence } from "./execution-evidence-schema.mjs";

/**
 * Normalize raw collector output into a canonical ExecutionEvidence.
 *
 * @param {object} raw - Raw evidence from a provider collector
 * @returns {object} Normalized ExecutionEvidence
 */
export function normalizeExecutionEvidence(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Cannot normalize null or non-object evidence");
  }

  const now = new Date().toISOString();

  // Start with skeleton and merge raw fields
  const evidence = createEvidenceSkeleton({
    execution_id: raw.execution_id,
    provider: raw.provider || "unknown",
    task_id: raw.task_id,
    goal_id: raw.goal_id || null,
  });

  // --- Set evidence_id ---
  evidence.evidence_id = raw.evidence_id || `evidence_${randomUUID()}`;

  // --- Runtime ---
  if (raw.runtime) {
    evidence.runtime = {
      ...evidence.runtime,
      ...raw.runtime,
    };
  }

  // --- Repository ---
  if (raw.repository) {
    evidence.repository = {
      ...evidence.repository,
      ...raw.repository,
    };
  }

  // --- Outcome ---
  if (raw.outcome) {
    evidence.outcome = {
      ...evidence.outcome,
      ...raw.outcome,
    };
  }

  // --- Normalize changes ---
  evidence.changes = normalizeChanges(raw.changes || raw.changed_files || []);

  // --- Normalize verification ---
  if (raw.verification) {
    evidence.verification = normalizeVerification(raw.verification, raw.tests);
  } else if (raw.tests) {
    // Build verification from raw 'tests' field
    evidence.verification = normalizeVerification({}, raw.tests);
  }

  // --- Artifacts ---
  if (Array.isArray(raw.artifacts)) {
    evidence.artifacts = raw.artifacts.map(normalizeArtifact);
  }

  // --- Integration ---
  if (raw.integration) {
    evidence.integration = {
      ...evidence.integration,
      ...raw.integration,
      required: raw.integration.required !== undefined ? !!raw.integration.required : false,
      satisfied: raw.integration.satisfied !== undefined ? !!raw.integration.satisfied : false,
    };
  }

  // --- Diagnostics ---
  evidence.diagnostics = {
    blockers: [],
    warnings: [],
  };

  // Auto-detect common issues
  if (evidence.repository) {
    if (evidence.repository.worktree_clean === false) {
      evidence.diagnostics.warnings.push({
        code: "dirty_worktree",
        message: "Worktree has uncommitted changes",
        source: "evidence_normalizer",
      });
    }
  }

  // If changes exist but no head_commit
  if (evidence.changes.length > 0 && !evidence.repository?.head_commit) {
    evidence.diagnostics.blockers.push({
      code: "changes_without_commit",
      message: "Code changes detected but no head commit recorded",
      source: "evidence_normalizer",
    });
  }

  // Unset/no-change without reason
  if (
    (!evidence.outcome?.reported_status || evidence.outcome.reported_status === "no_change") &&
    !evidence.outcome?.no_change_reason &&
    evidence.changes.length === 0
  ) {
    evidence.diagnostics.warnings.push({
      code: "no_change_no_reason",
      message: "No change detected but no explanation provided",
      source: "evidence_normalizer",
    });
  }

  // Merge diagnostics from raw
  if (raw.diagnostics) {
    if (Array.isArray(raw.diagnostics.blockers)) {
      evidence.diagnostics.blockers.push(...raw.diagnostics.blockers);
    }
    if (Array.isArray(raw.diagnostics.warnings)) {
      evidence.diagnostics.warnings.push(...raw.diagnostics.warnings);
    }
  }

  // --- Provenance ---
  evidence.provenance = {
    collected_at: now,
    collector: raw.provenance?.collector || raw.collector || "evidence_normalizer",
    source_refs: raw.provenance?.source_refs || [],
  };

  // Validate before returning
  const { errors } = validateExecutionEvidence(evidence);
  if (errors.length > 0) {
    throw new Error(`Normalized evidence failed validation: ${errors.join("; ")}`);
  }

  return evidence;
}

/**
 * Normalize changed_files or changes array.
 * @param {Array} input
 * @returns {Array<{path: string, status: string}>}
 */
function normalizeChanges(input) {
  if (!Array.isArray(input)) return [];

  return input.map((item) => {
    if (typeof item === "string") {
      return { path: item, status: "modified" };
    }
    if (item && typeof item === "object") {
      return {
        path: item.path || item.file || "unknown",
        status: item.status || "modified",
      };
    }
    return { path: String(item), status: "modified" };
  });
}

/**
 * Normalize verification result.
 * @param {object} verification - Verification object
 * @param {Array|string} [rawTests] - Raw tests field for backward compat
 * @returns {{ passed: boolean, commands: Array }}
 */
function normalizeVerification(verification, rawTests) {
  const commands = Array.isArray(verification.commands) ? [...verification.commands] : [];

  // Normalize raw tests field into commands
  if (rawTests) {
    const testsArray = Array.isArray(rawTests) ? rawTests : [String(rawTests)];
    for (const test of testsArray) {
      const testStr = typeof test === "object" ? JSON.stringify(test) : String(test);
      // Only add if not already present as a command
      if (!commands.find((c) => c.cmd === testStr)) {
        commands.push({
          cmd: testStr,
          exit_code: test.exit_code ?? null,
          passed: test.passed ?? null,
        });
      }
    }
  }

  // passed must be explicitly boolean
  const passed = typeof verification.passed === "boolean"
    ? verification.passed
    : commands.length > 0
      ? commands.every((c) => c.passed === true)
      : false;

  return { passed, commands };
}

/**
 * Normalize an artifact entry.
 * @param {object} artifact
 * @returns {object}
 */
function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return { kind: "unknown", path: String(artifact), sha256: null, fresh: false };
  }
  return {
    kind: artifact.kind || "unknown",
    path: artifact.path || artifact.file || null,
    sha256: artifact.sha256 || null,
    fresh: artifact.fresh !== undefined ? !!artifact.fresh : false,
  };
}
