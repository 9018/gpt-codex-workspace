/**
 * acceptance-result-file.mjs — Acceptance result file schema and I/O.
 *
 * Defines a standard acceptance result file format (acceptance.json) that
 * is produced by the acceptance gate orchestrator or judgment module.
 *
 * Schema version: gptwork.acceptance_result.v1
 *
 * Acceptance states:
 *   accepted         (通过) — Task accepted, all gates passed
 *   failed           (未通过) — Task rejected, blocking gates failed
 *   needs_continue   (需继续处理) — Task can continue with follow-up
 */

export const ACCEPTANCE_RESULT_SCHEMA_VERSION = "gptwork.acceptance_result.v1";

const VALID_JUDGMENTS = new Set(["accepted", "failed", "needs_continue"]);

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create a structured acceptance result object.
 *
 * @param {object} options
 * @param {"accepted"|"failed"|"needs_continue"} options.judgment — Overall acceptance judgment
 * @param {string} [options.rationale] — Human-readable explanation
 * @param {Array<{code:string,message:string}>} [options.blockers]
 * @param {Array<{code:string,message:string}>} [options.followups]
 * @param {object} [options.verification] — Reference to the verification result used
 * @param {object} [options.judgment_detail] — Full judgment object from acceptance-judgment
 * @param {object} [options.closure_decision] — Closure decision if computed
 * @param {object} [options.contract_summary] — Summary of contract used
 * @param {object} [options.metadata] — Additional metadata
 * @param {string|null} [options.task_id]
 * @param {string|null} [options.goal_id]
 * @returns {object} structured acceptance result
 */
export function createAcceptanceResult({
  judgment = "needs_continue",
  rationale = "",
  blockers = [],
  followups = [],
  verification = null,
  judgment_detail = null,
  closure_decision = null,
  contract_summary = null,
  metadata = {},
  task_id = null,
  goal_id = null,
} = {}) {
  if (!VALID_JUDGMENTS.has(judgment)) {
    throw new Error(`Invalid acceptance judgment: ${judgment}. Must be one of: ${[...VALID_JUDGMENTS].join(", ")}`);
  }

  return {
    schema_version: ACCEPTANCE_RESULT_SCHEMA_VERSION,
    judgment,
    accepted: judgment === "accepted",
    failed: judgment === "failed",
    needs_continue: judgment === "needs_continue",
    timestamp: new Date().toISOString(),
    task_id,
    goal_id,
    rationale: String(rationale || ""),
    blockers: normalizeList(blockers).map(b => ({
      code: b.code || "unknown",
      message: b.message || "",
      severity: b.severity || "blocker",
      source: b.source || "acceptance_gate",
    })),
    followups: normalizeList(followups).map(f => ({
      code: f.code || "unknown",
      message: f.message || "",
      severity: f.severity || "followup",
      source: f.source || "acceptance_gate",
    })),
    verification: isObject(verification) ? {
      schema_version: verification.schema_version,
      judgment: verification.judgment,
      passed: verification.passed === true,
      command_count: normalizeList(verification.commands).length,
      findings_count: normalizeList(verification.findings).length,
      summary: verification.summary || null,
    } : null,
    judgment_detail: isObject(judgment_detail) ? judgment_detail : null,
    closure_decision: isObject(closure_decision) ? closure_decision : null,
    contract_summary: isObject(contract_summary) ? contract_summary : null,
    metadata: isObject(metadata) ? metadata : {},
  };
}

/**
 * Write an acceptance result file.
 *
 * @param {string} path — Output file path
 * @param {object} result — Acceptance result object
 * @returns {Promise<void>}
 */
export async function writeAcceptanceResultFile(path, result) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + "\n", "utf8");
}

/**
 * Read and validate an acceptance result file.
 *
 * @param {string} path — Path to acceptance result JSON file
 * @returns {Promise<object>} parsed acceptance result
 * @throws {Error} If file is missing or invalid
 */
export async function readAcceptanceResultFile(path) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Acceptance result must be a JSON object");
  }
  if (!VALID_JUDGMENTS.has(parsed.judgment)) {
    throw new Error(`Invalid judgment in acceptance result: ${parsed.judgment}`);
  }
  return parsed;
}

/**
 * Check whether an acceptance result file exists and is valid.
 *
 * @param {string} path
 * @returns {Promise<{exists:boolean,valid:boolean,error?:string,judgment?:string}>}
 */
export async function checkAcceptanceResultFile(path) {
  try {
    const parsed = await readAcceptanceResultFile(path);
    return { exists: true, valid: true, judgment: parsed.judgment };
  } catch (err) {
    const { access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    try {
      await access(path, constants.F_OK);
      return { exists: true, valid: false, error: err.message };
    } catch {
      return { exists: false, valid: false, error: "File not found" };
    }
  }
}
