// @ts-check
/**
 * TUI Task Delta Protocol — structured same-task delta for review/repair flow.
 */

const KIND_ALIASES = Object.freeze({
  supervisor_correction: "correction",
});

const ALLOWED_KINDS = Object.freeze(
  new Set([
    "new_evidence",
    "verification_failure",
    "review_findings",
    "repair_instruction",
    "rerun_verification",
    "operator_note",
    "context_refresh",
    "correction",
    "instruction",
  ])
);

const FIXED_CONTRACT_FIELDS = Object.freeze(
  new Set([
    "objective",
    "scope",
    "acceptance_criteria",
    "workstream_id",
    "destructive_permission",
  ])
);

/**
 * Validate a task delta against the current session state.
 * @param {object} delta
 * @param {object} session
 * @returns {object} validated delta
 * @throws {Error}
 */
function normalizeContextDigest(value) {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  const match = /^sha256:([0-9a-f]+)$/i.exec(normalized);
  return match ? `sha256:${match[1].toLowerCase()}` : normalized;
}

export function validateTaskDelta(delta, session) {
  if (!delta || typeof delta !== "object") {
    throw new Error("delta must be an object");
  }
  const normalized = {
    ...delta,
    kind: KIND_ALIASES[delta.kind] || delta.kind,
  };
  if (!ALLOWED_KINDS.has(normalized.kind)) {
    throw new Error(`unsupported delta kind: ${delta.kind}`);
  }
  if (normalized.task_id !== session.task_id) {
    throw new Error("delta task_id does not match session");
  }
  if (normalized.goal_id !== session.goal_id) {
    throw new Error("delta goal_id does not match session");
  }
  const deltaContextDigest = normalizeContextDigest(normalized.base_context_digest);
  const sessionContextDigest = normalizeContextDigest(session.task_context_digest);
  // Allow first correction during early TUI bootstrap when session digest has not been
  // materialized yet. Prefer binding the provided digest into the delta for auditability.
  if (sessionContextDigest) {
    if (!deltaContextDigest || deltaContextDigest !== sessionContextDigest) {
      throw new Error("delta context digest mismatch");
    }
    normalized.base_context_digest = sessionContextDigest;
  } else if (deltaContextDigest) {
    normalized.base_context_digest = deltaContextDigest;
  } else {
    // No digest available yet; still allow operator/GPT correction so the loop can re-align.
    normalized.base_context_digest = null;
    normalized.digest_deferred = true;
  }

  const expectedRevision =
    Number(session.active_delta_revision || 0) + 1;
  if (normalized.revision !== expectedRevision) {
    throw new Error(
      `delta revision must be ${expectedRevision}, got ${normalized.revision}`
    );
  }

  for (const field of FIXED_CONTRACT_FIELDS) {
    if (normalized[field] !== undefined) {
      throw new Error(`delta cannot modify fixed field: ${field}`);
    }
  }

  return normalized;
}

/**
 * Render a delta instruction for TUI input.
 * @param {object} delta
 * @returns {string}
 */
export function renderDeltaInstruction(delta) {
  const lines = [
    "BEGIN GPTWORK TASK DELTA",
    `task_id=${delta.task_id}`,
    `goal_id=${delta.goal_id}`,
    `revision=${delta.revision}`,
    `kind=${delta.kind}`,
    `required_next_role=${delta.required_next_role || "none"}`,
    "",
    "This delta supplements the existing task contract.",
    "It does not replace objective, scope, acceptance criteria, or constraints.",
    "",
    JSON.stringify(
      {
        findings: delta.findings || [],
        allowed_scope: delta.allowed_scope || [],
        evidence_refs: delta.evidence_refs || [],
        repair_round: delta.repair_round || null,
        instruction: delta.instruction || delta.text || null,
      },
      null,
      2
    ),
    "END GPTWORK TASK DELTA",
  ];
  return lines.join("\n");
}

/**
 * Append a delta entry to the task deltas JSONL file.
 * @param {string} goalDir
 * @param {object} delta
 * @returns {Promise<object>}
 */
export async function appendTaskDelta(goalDir, delta) {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(goalDir, { recursive: true });
  const deltasPath = join(goalDir, "task.deltas.jsonl");
  await appendFile(deltasPath, JSON.stringify(delta) + "\n", "utf8");
  return delta;
}
