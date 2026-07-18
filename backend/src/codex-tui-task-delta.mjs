// @ts-check
/**
 * TUI Task Delta Protocol — structured same-task delta for review/repair flow.
 */

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
export function validateTaskDelta(delta, session) {
  if (!delta || typeof delta !== "object") {
    throw new Error("delta must be an object");
  }
  if (!ALLOWED_KINDS.has(delta.kind)) {
    throw new Error(`unsupported delta kind: ${delta.kind}`);
  }
  if (delta.task_id !== session.task_id) {
    throw new Error("delta task_id does not match session");
  }
  if (delta.goal_id !== session.goal_id) {
    throw new Error("delta goal_id does not match session");
  }
  if (delta.base_context_digest !== session.task_context_digest) {
    throw new Error("delta context digest mismatch");
  }

  const expectedRevision =
    Number(session.active_delta_revision || 0) + 1;
  if (delta.revision !== expectedRevision) {
    throw new Error(
      `delta revision must be ${expectedRevision}, got ${delta.revision}`
    );
  }

  // Reject changes to fixed contract fields
  for (const field of FIXED_CONTRACT_FIELDS) {
    if (delta[field] !== undefined) {
      throw new Error(`delta cannot modify fixed field: ${field}`);
    }
  }

  return delta;
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
