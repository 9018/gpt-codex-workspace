/**
 * verification-result-file.mjs — Verification result file schema and I/O.
 *
 * Defines a standard verification result file format (verification.json)
 * that can be produced by the independent verifier and consumed by the
 * acceptance judgment module.
 *
 * Schema version: gptwork.verification_result.v1
 *
 * Result judgment states:
 *   passed    — all checks passed, task is verified
 *   failed    — blocking checks failed, task is rejected
 *   needs_continue — non-blocking issues found, task can proceed with follow-up
 */

export const VERIFICATION_RESULT_SCHEMA_VERSION = "gptwork.verification_result.v1";

const VALID_JUDGMENTS = new Set(["passed", "failed", "needs_continue"]);

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create a structured verification result.
 *
 * @param {object} options
 * @param {"passed"|"failed"|"needs_continue"} options.judgment — Overall judgment
 * @param {Array<{cmd:string,exit_code:number,stdout_tail?:string,stderr_tail?:string}>} [options.commands]
 * @param {Array<{severity:string,code:string,message:string,source?:string}>} [options.findings]
 * @param {Array<string>} [options.changed_files]
 * @param {Array<{cmd:string,reason:string}>} [options.skipped_checks]
 * @param {string|null} [options.reason_no_tests]
 * @param {object} [options.contract_verification]
 * @param {object} [options.metadata]
 * @param {string|null} [options.task_id]
 * @param {string|null} [options.goal_id]
 * @returns {object} structured verification result
 */
export function createVerificationResult({
  judgment = "needs_continue",
  commands = [],
  findings = [],
  changed_files = [],
  skipped_checks = [],
  reason_no_tests = null,
  contract_verification = null,
  metadata = {},
  task_id = null,
  goal_id = null,
} = {}) {
  if (!VALID_JUDGMENTS.has(judgment)) {
    throw new Error(`Invalid verification judgment: ${judgment}. Must be one of: passed, failed, needs_continue`);
  }

  return {
    schema_version: VERIFICATION_RESULT_SCHEMA_VERSION,
    judgment,
    passed: judgment === "passed",
    needs_continue: judgment === "needs_continue",
    failed: judgment === "failed",
    timestamp: new Date().toISOString(),
    task_id,
    goal_id,
    commands: normalizeList(commands).map(c => ({
      cmd: String(c.cmd || c.command || ""),
      exit_code: typeof c.exit_code === "number" ? c.exit_code : (c.passed === false ? 1 : 0),
      stdout_tail: String(c.stdout_tail || c.stdout || "").slice(-4000),
      stderr_tail: String(c.stderr_tail || c.stderr || "").slice(-4000),
    })),
    findings: normalizeList(findings).map(f => ({
      severity: f.severity || "info",
      code: f.code || "unknown",
      message: f.message || "",
      source: f.source || "independent_verifier",
      evidence: isObject(f.evidence) ? f.evidence : undefined,
    })),
    changed_files: normalizeList(changed_files),
    skipped_checks: normalizeList(skipped_checks).map(s => ({
      cmd: String(s.cmd || s.command || ""),
      reason: s.reason || "not_applicable",
    })),
    reason_no_tests: reason_no_tests || null,
    contract_verification: isObject(contract_verification) ? contract_verification : null,
    metadata: isObject(metadata) ? metadata : {},
    summary: deriveSummary(judgment, findings),
  };
}

function deriveSummary(judgment, findings) {
  const blockerCount = findings.filter(f => f.severity === "blocker" || f.severity === "major").length;
  if (judgment === "passed") return "All verification checks passed.";
  if (judgment === "failed") {
    const reasons = findings.filter(f => f.severity === "blocker" || f.severity === "major").map(f => f.code).join(", ");
    return `Verification failed: ${reasons || "blocking checks failed"}.`;
  }
  if (blockerCount > 0) {
    return `Verification needs continue: ${blockerCount} non-blocking issue(s) remain.`;
  }
  return "Verification needs further processing.";
}

/**
 * Write a verification result file.
 *
 * @param {string} path — Output file path
 * @param {object} result — Verification result object
 * @returns {Promise<void>}
 */
export async function writeVerificationResultFile(path, result) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + "\n", "utf8");
}

/**
 * Read and validate a verification result file.
 *
 * @param {string} path — Path to verification result JSON file
 * @returns {Promise<object>} parsed verification result
 * @throws {Error} If file is missing or invalid
 */
export async function readVerificationResultFile(path) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Verification result must be a JSON object");
  }
  if (!VALID_JUDGMENTS.has(parsed.judgment)) {
    throw new Error(`Invalid judgment in verification result: ${parsed.judgment}`);
  }
  return parsed;
}

/**
 * Check whether a verification result file exists and is valid.
 *
 * @param {string} path
 * @returns {Promise<{exists:boolean,valid:boolean,error?:string}>}
 */
export async function checkVerificationResultFile(path) {
  try {
    const parsed = await readVerificationResultFile(path);
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

export { VALID_JUDGMENTS };
