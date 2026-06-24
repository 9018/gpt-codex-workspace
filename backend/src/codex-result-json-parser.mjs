import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { VALID_STATUSES } from "./codex-finalizer-contract.mjs";

export async function parseResultJson(resultJsonPath) {
  if (!resultJsonPath) return null;
  try {
    if (!existsSync(resultJsonPath)) return null;
    const text = await readFile(resultJsonPath, "utf8");
    const data = JSON.parse(text);

    // Validate contract fields
    
    const status = data.status && VALID_STATUSES.includes(data.status) ? data.status : null;
    const summary = typeof data.summary === "string" ? data.summary : null;
    const changedFiles = Array.isArray(data.changed_files) ? data.changed_files.filter(f => typeof f === "string") : [];
    const tests = typeof data.tests === "string" ? data.tests : null;
    const commit = typeof data.commit === "string" ? data.commit : null;
    const remoteHead = typeof data.remote_head === "string" ? data.remote_head : null;
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(w => typeof w === "string") : [];
    const followups = Array.isArray(data.followups) ? data.followups.filter(f => typeof f === "string") : [];
    const reviewerDecision = data.reviewer_decision && typeof data.reviewer_decision === "object" ? data.reviewer_decision : null;
    const acceptanceFindings = Array.isArray(data.acceptance_findings) ? data.acceptance_findings.filter(f => f && typeof f === "object") : [];
    const nextTasks = Array.isArray(data.next_tasks) ? data.next_tasks.filter(t => t && typeof t === "object") : [];
    const repairProposal = data.repair_proposal && typeof data.repair_proposal === "object" ? data.repair_proposal : null;

    if (!status) return null;

    // Autonomy/subagent reporting fields (optional, P0.4/P1.1)
    const subagentsUsed = data.subagents_used === true ? true : false;
    const subagents = Array.isArray(data.subagents) ? data.subagents : null;
    const gptQuestionsUsed = typeof data.gpt_questions_used === 'number' ? data.gpt_questions_used : null;
    const decisionLog = Array.isArray(data.decision_log) ? data.decision_log : null;
    const verification = data.verification && typeof data.verification === 'object' ? data.verification : null;
    const escalation = data.escalation && typeof data.escalation === 'object' ? data.escalation : null;


    return {
      status,
      summary,
      changed_files: changedFiles,
      tests,
      commit,
      remote_head: remoteHead,
      warnings,
      followups,
      reviewer_decision: reviewerDecision,
      acceptance_findings: acceptanceFindings,
      next_tasks: nextTasks,
      repair_proposal: repairProposal,
      subagents_used: subagentsUsed,
      subagents,
      gpt_questions_used: gptQuestionsUsed,
      decision_log: decisionLog,
      verification,
      escalation,
      structured: true,
      from_json: true,
      json_errors: [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// stdout structured parser (original)
// ---------------------------------------------------------------------------

/**
 * Parse the structured report from Codex output.
 *
 * @param {string} output - The raw output from Codex CLI execution.
 * @returns {object} Parsed result with:
 *   - status: "completed" | "failed" | "timed_out" | null
 *   - summary: string or null
 *   - changed_files: string[] (empty if none)
 *   - tests: string or null
 *   - commit: string or null
 *   - remote_head: string or null
 *   - warnings: string[] (always empty from stdout parser)
 *   - followups: string[] (always empty from stdout parser)
 *   - structured: boolean - true if any structured fields were found
 *   - from_json: false
 *   - raw_summary_excerpt: first 500 chars of raw output for diagnostics
 */
