/**
 * full-machine-acceptance.mjs — Machine acceptance for full execution mode.
 *
 * Produces one of four verdicts:
 *   pass          → auto-integrate
 *   repairable    → auto-retry
 *   terminal_fail → permanent failure
 *   needs_decision→ escalate to human
 *
 * Never returns "waiting_for_review" — that is not a machine verdict.
 */

import { buildTaskRuntimeAggregate } from "../runtime/task-runtime-aggregate.mjs";

const VERDICT = Object.freeze({
  PASS: "pass",
  REPAIRABLE: "repairable",
  TERMINAL_FAIL: "terminal_fail",
  NEEDS_DECISION: "needs_decision",
});

function finding(code, blocking = false, extra = {}) {
  return { code, blocking, severity: blocking ? "blocker" : "minor", ...extra };
}

function classifyRepairability(findings) {
  const blockers = findings.filter((f) => f.blocking);
  if (blockers.length === 0) return VERDICT.PASS;

  const terminalCodes = new Set([
    "contract_invalid",
    "retry_budget_exhausted",
    "merge_conflict_requires_product_decision",
    "semantic_conflict",
  ]);

  const hasTerminal = blockers.some((f) => terminalCodes.has(f.code));
  if (hasTerminal) return VERDICT.TERMINAL_FAIL;

  const hasMissingResult = blockers.some((f) => f.code === "missing_result_json");
  const hasMissingCommit = blockers.some((f) => f.code === "missing_commit");
  if (hasMissingResult && hasMissingCommit) return VERDICT.REPAIRABLE;

  const hasCheckFailure = blockers.some((f) => f.code === "required_check_missing_or_failed");
  if (hasCheckFailure) return VERDICT.REPAIRABLE;

  const hasFilesMismatch = blockers.some((f) => f.code === "changed_files_mismatch");
  if (hasFilesMismatch) return VERDICT.NEEDS_DECISION;

  return VERDICT.NEEDS_DECISION;
}

export async function acceptFullTask(options = {}) {
  const { store, taskId, config = {} } = options;
  if (!store) throw new Error("store is required");
  if (!taskId) throw new Error("taskId is required");

  const state = await store.load();
  const task = Array.isArray(state.tasks) ? state.tasks.find((t) => t.id === taskId) : null;
  if (!task) throw new Error(`task not found: ${taskId}`);

  const aggregate = await buildTaskRuntimeAggregate({ task, workspaceRoot: config.defaultWorkspaceRoot, config });
  const contract = task.acceptance_contract || {};
  const result = task.result || {};
  const evidence = aggregate.evidence;
  const findings = [];

  if (!evidence.result_json) {
    findings.push(finding("missing_result_json", true, { message: "result.json not found" }));
  }
  if (!evidence.commit || evidence.commit === "none") {
    if (contract.requires_commit !== false) {
      findings.push(finding("missing_commit", true, { message: "No commit found in evidence" }));
    }
  }
  if (result.changed_files && aggregate.worktree.changed_files) {
    const resultFiles = new Set(result.changed_files);
    const worktreeFiles = new Set(aggregate.worktree.changed_files);
    const diff = new Set([...resultFiles].filter((f) => !worktreeFiles.has(f))
      .concat([...worktreeFiles].filter((f) => !resultFiles.has(f))));
    if (diff.size > 0) {
      findings.push(finding("changed_files_mismatch", true, {
        message: `changed_files differ: ${[...diff].join(", ")}`,
      }));
    }
  }
  const requiredChecks = Array.isArray(contract.required_checks) ? contract.required_checks : [];
  const runChecks = Array.isArray(result.checks) ? result.checks : [];
  for (const required of requiredChecks) {
    const check = runChecks.find((c) => c.command === required || c.cmd === required);
    if (!check || check.status !== "passed" || check.exit_code !== 0) {
      findings.push(finding("required_check_missing_or_failed", true, {
        message: `Required check "${required}" missing or failed`,
      }));
    }
  }

  const verdict = classifyRepairability(findings);
  return {
    task_id: taskId,
    verdict,
    findings,
    required_evidence_complete: evidence.result_json && Boolean(evidence.commit),
    eligible_for_retry: verdict === VERDICT.REPAIRABLE,
    eligible_for_integration: verdict === VERDICT.PASS && (contract.requires_integration !== false),
    aggregate,
  };
}

export { VERDICT, classifyRepairability };
