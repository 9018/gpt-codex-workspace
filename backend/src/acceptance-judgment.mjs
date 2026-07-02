/**
 * acceptance-judgment.mjs — Acceptance gate judgment module.
 *
 * Provides a clear three-way acceptance judgment:
 *   accepted      (通过) — All gates passed, task is accepted
 *   failed        (未通过) — Blocking gates failed, task is rejected
 *   needs_continue (需继续处理) — Non-blocking issues found, task can continue
 *
 * This module takes a verification result and optionally an acceptance
 * contract, applies judgment rules, and produces a structured acceptance
 * result with a clear rationale for each decision.
 *
 * The judgment is designed to be:
 * - Deterministic: same inputs always produce same judgment
 * - Traceable: every judgment includes a rationale with evidence references
 * - Compatible: can be used standalone or integrated into the existing
 *   acceptance gate engine (acceptance-gate-engine.mjs)
 */

export const ACCEPTANCE_JUDGMENT_SCHEMA_VERSION = "gptwork.acceptance_judgment.v1";
export const VALID_JUDGMENTS = Object.freeze(["accepted", "failed", "needs_continue"]);

/**
 * Acceptance judgment result object.
 *
 * @typedef {object} AcceptanceJudgment
 * @property {"accepted"|"failed"|"needs_continue"} judgment
 * @property {boolean} accepted - true if judgment === "accepted"
 * @property {boolean} failed - true if judgment === "failed"
 * @property {boolean} needs_continue - true if judgment === "needs_continue"
 * @property {string} rationale - Human-readable explanation
 * @property {Array<{code:string,message:string,severity:string}>} blockers
 * @property {Array<{code:string,message:string,severity:string}>} followups
 * @property {object} evidence - Summary of evidence considered
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasSeverity(findings, ...severities) {
  return normalizeList(findings).some(f => severities.includes(f?.severity));
}

function filterBySeverity(findings, ...severities) {
  return normalizeList(findings).filter(f => severities.includes(f?.severity));
}

function filterOutSeverity(findings, ...severities) {
  return normalizeList(findings).filter(f => !severities.includes(f?.severity));
}

// ---------------------------------------------------------------------------
// Core judgment logic
// ---------------------------------------------------------------------------

/**
 * Judge acceptance based on verification result and optional contract.
 *
 * The three-way judgment logic follows these rules:
 *
 * R1: Task result status is "failed" → gate failed
 * R2: Blocking findings exist (blocker/major severity) → gate failed
 * R3: Verification judgment is "failed" → gate failed
 * R4: Commands failed without blockers or warnings → gate needs_continue
 * R5: Verification judgment is "needs_continue" → gate needs_continue
 * R6: Task status not "completed" → gate needs_continue
 * R7: Contract requirements not met → gate needs_continue
 * R8: All clear → gate accepted (possibly with follow-ups)
 *
 * @param {object} options
 * @param {object} [options.verificationResult] — Result from independent verifier or task-verifier
 * @param {object} [options.contract] — Acceptance contract (optional)
 * @param {object} [options.result] — Task result (optional, for additional context)
 * @param {object} [options.task] — Task object (optional)
 * @param {object} [options.goal] — Goal object (optional)
 * @returns {AcceptanceJudgment}
 */
export function judgeAcceptance({
  verificationResult = null,
  contract = null,
  result = null,
  task = null,
  goal = null,
} = {}) {
  const vr = isObject(verificationResult) ? verificationResult : {};
  const r = isObject(result) ? result : {};

  // Collect all findings from verification result
  const vrFindings = normalizeList(vr.findings || []);
  const vrCommands = normalizeList(vr.commands || []);

  // Extract judgment. Only use vr.judgment if explicitly set.
  // Do NOT derive "failed" from vr.passed === false — that's ambiguous.
  const explicitJudgment = vr.judgment && typeof vr.judgment === "string"
    ? (["passed", "failed", "needs_continue"].includes(vr.judgment) ? vr.judgment : null)
    : null;

  const contractPresent = isObject(contract);
  const resultStatus = r.status || "unknown";

  // Classify findings
  const blockers = filterBySeverity(vrFindings, "blocker", "major");
  const warnings = filterBySeverity(vrFindings, "warning");
  const followups = filterBySeverity(vrFindings, "followup", "info");
  const otherFindings = filterOutSeverity(vrFindings, "blocker", "major", "warning", "followup", "info");

  const commandFailures = vrCommands.filter(c => c.exit_code !== 0 && c.exit_code !== undefined);
  const hasCommandFailures = commandFailures.length > 0;
  const hasBlockers = blockers.length > 0;
  const hasWarnings = warnings.length > 0;
  const hasFollowups = followups.length > 0;
  const resultIsFailed = resultStatus === "failed";
  const resultIsCompleted = resultStatus === "completed";
  const verificationPassed = vr.passed === true || explicitJudgment === "passed" || (explicitJudgment === null && vr.passed !== false && vrCommands.length > 0 && vrCommands.every(c => c.exit_code === 0 || c.exit_code === undefined));

  // Build evidence summary
  const evidence = {
    explicit_judgment: explicitJudgment,
    verification_passed: verificationPassed,
    result_status: resultStatus,
    command_count: vrCommands.length,
    command_failures: commandFailures.length,
    blocker_count: blockers.length,
    warning_count: warnings.length,
    followup_count: followups.length,
    contract_present: contractPresent,
  };

  // ============ Judgment Rules ============

  // R1: Task result is "failed"
  if (resultIsFailed) {
    return buildJudgment("failed", {
      rationale: `Task result status is "failed": ${r.summary || "No summary provided"}.`,
      blockers: [{ severity: "blocker", code: "result_failed", message: r.summary || "Task result is failed", source: "acceptance_judgment" }],
      followups: [...warnings, ...followups],
      evidence,
      contract,
    });
  }

  // R2: Blockers in verification findings → gate failed
  if (hasBlockers) {
    return buildJudgment("failed", {
      rationale: `Blocking finding(s) found: ${blockers.map(b => b.code).join(", ")}.`,
      blockers,
      followups: [...warnings, ...followups, ...otherFindings],
      evidence,
      contract,
    });
  }

  // R3: Explicit verification judgment is "failed" → gate failed
  if (explicitJudgment === "failed") {
    return buildJudgment("failed", {
      rationale: `Verification judgment explicitly reports "failed".`,
      blockers,
      followups: [...warnings, ...followups, ...otherFindings],
      evidence,
      contract,
    });
  }

  // R4: Commands failed but no blockers/warnings → needs_continue
  if (hasCommandFailures && !hasBlockers) {
    return buildJudgment("needs_continue", {
      rationale: `${commandFailures.length} command(s) failed but no explicit blockers found. Needs further processing.`,
      blockers,
      followups: [...warnings, ...followups, ...otherFindings,
        { severity: "followup", code: "command_failures_pending", message: `${commandFailures.length} verification command(s) failed: ${commandFailures.map(c => c.cmd).join(", ")}.` },
      ],
      evidence,
      contract,
    });
  }

  // R5: Explicit verification judgment is "needs_continue"
  if (explicitJudgment === "needs_continue") {
    return buildJudgment("needs_continue", {
      rationale: `Verification judgment is "needs_continue". Non-blocking issues require follow-up.`,
      blockers,
      followups: [...warnings, ...followups, ...otherFindings],
      evidence,
      contract,
    });
  }

  // R6: Task not completed → needs_continue
  if (!resultIsCompleted) {
    return buildJudgment("needs_continue", {
      rationale: `Task result status is "${resultStatus}". Task is not yet completed.`,
      blockers,
      followups: [...warnings, ...followups],
      evidence,
      contract,
    });
  }

  // R7: Contract requirements check
  // If contract present and non-blocking, flag as needs_continue
  // (Blocking requirements are already caught as blockers above)
  if (contractPresent && !verificationPassed) {
    return buildJudgment("needs_continue", {
      rationale: `Contract present but verification did not pass. Needs further processing.`,
      blockers,
      followups: [...warnings, ...followups, ...otherFindings],
      evidence,
      contract,
    });
  }

  // R8: Check if verification actually passed (for non-explicit case)
  if (!verificationPassed && !hasCommandFailures && !hasBlockers) {
    return buildJudgment("needs_continue", {
      rationale: "Verification status is ambiguous (not passed, no blockers). Needs review.",
      blockers,
      followups: [...warnings, ...followups, ...otherFindings],
      evidence,
      contract,
    });
  }

  // R9: All clear → accepted
  const notes = [];
  if (hasWarnings) notes.push(`${warnings.length} warning(s)`);
  if (hasFollowups) notes.push(`${followups.length} follow-up(s)`);
  const noteText = notes.length > 0 ? ` (with ${notes.join(", ")})` : "";

  return buildJudgment("accepted", {
    rationale: `All gates passed${noteText}. Task is accepted.`,
    blockers,
    followups: [...warnings, ...followups, ...otherFindings],
    evidence,
    contract,
  });
}

// ---------------------------------------------------------------------------
// Judgment builder
// ---------------------------------------------------------------------------

function buildJudgment(judgment, { rationale, blockers = [], followups = [], evidence = {}, contract = null } = {}) {
  return {
    schema_version: ACCEPTANCE_JUDGMENT_SCHEMA_VERSION,
    judgment,
    accepted: judgment === "accepted",
    failed: judgment === "failed",
    needs_continue: judgment === "needs_continue",
    timestamp: new Date().toISOString(),
    rationale,
    blockers: normalizeList(blockers).map(f => ({
      code: f.code || "unknown",
      message: f.message || "",
      severity: f.severity || "blocker",
      source: f.source || "acceptance_judgment",
    })),
    followups: normalizeList(followups).map(f => ({
      code: f.code || "unknown",
      message: f.message || "",
      severity: f.severity || "followup",
      source: f.source || "acceptance_judgment",
    })),
    evidence,
    contract_summary: isObject(contract) ? {
      present: true,
      operation_kind: contract.intent?.operation_kind || null,
      blocking_requirements_count: normalizeList(contract.blocking_requirements).length,
      requires_commit: contract.requirements?.requires_commit === true,
      requires_integration: contract.requirements?.requires_integration === true,
      requires_deployment: contract.requirements?.requires_deployment === true,
    } : { present: false },
  };
}

// ---------------------------------------------------------------------------
// Mapping to task status
// ---------------------------------------------------------------------------

/**
 * Map acceptance judgment to a task status string.
 *
 * @param {AcceptanceJudgment|string} judgment — Judgment object or judgment string
 * @returns {string} Mapped task status
 */
export function mapJudgmentToTaskStatus(judgment) {
  const j = typeof judgment === "string" ? judgment : judgment?.judgment;
  if (j === "accepted") return "completed";
  if (j === "failed") return "failed";
  if (j === "needs_continue") return "waiting_for_review";
  return "waiting_for_review";
}

/**
 * Check if an acceptance judgment allows auto-completion.
 *
 * @param {AcceptanceJudgment|string} judgment
 * @returns {boolean}
 */
export function judgmentAllowsAutoComplete(judgment) {
  const j = typeof judgment === "string" ? judgment : judgment?.judgment;
  return j === "accepted";
}
