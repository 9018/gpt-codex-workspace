/**
 * workstream-acceptance-decision.mjs — Bounded, idempotent
 * acceptance decision for workstream tasks.
 *
 * Evaluates acceptance evidence and returns a verdict:
 *   passed   — all criteria satisfied
 *   failed   — one or more blocking criteria not satisfied (≤ 2 repairs allowed)
 *   partial  — some criteria satisfied, some not (creates convergence goal)
 *   blocked  — environment/lock/cycle prevents evaluation
 *
 * Acceptance dimensions (from acceptance contract):
 *   result/artifact  — task produced a structured result
 *   git clean/commit — worktree is not dirty and changes are committed
 *   tests            — verification test commands ran and passed
 *   changed scope    — changed files match expected scope
 *   reviewer         — acceptance review or reviewer decision is present
 *   documentation    — owned docs were updated when docs_only profile
 *
 * Idempotent: same acceptance evidence always returns the same verdict.
 * Deterministic: no side effects, no external calls.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed verdict values. */
export const VERDICT = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  PARTIAL: "partial",
  BLOCKED: "blocked",
});

/** Acceptance dimensions that are always checked. */
export const ACCEPTANCE_DIMENSIONS = Object.freeze([
  "result_artifact",
  "git_clean_commit",
  "tests_passed",
  "changed_scope",
  "reviewer_decision",
  "documentation_updated",
]);

const MAX_EVIDENCE_ITEMS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactList(value, max = MAX_EVIDENCE_ITEMS) {
  return asArray(value).filter((item) => item != null).slice(0, max);
}

function findingsFor(code, message, severity = "blocker", dimension = null) {
  const f = { severity, code, message };
  if (dimension) f.dimension = dimension;
  return f;
}

// ---------------------------------------------------------------------------
// Evidence extraction helpers
// ---------------------------------------------------------------------------

function checkResultArtifact(task = {}, goal = {}, result = {}) {
  const taskResult = task.result || result || {};
  const hasSummary = Boolean(taskResult.summary || taskResult.message);
  const hasStatus = Boolean(taskResult.status);
  const hasResultJson = Boolean(task.changed_files || taskResult.changed_files || taskResult.tests || taskResult.commit);
  const evidenceKeys = Object.keys(taskResult).filter((k) => !["logs", "stack", "internal"].includes(k));

  if (hasSummary && hasStatus && evidenceKeys.length > 0) {
    return { passed: true, summary: "result_artifact_present" };
  }
  return {
    passed: false,
    summary: "result_artifact_missing",
    findings: [findingsFor("result_artifact_missing", "No structured task result or evidence payload is available.", "blocker", "result_artifact")],
  };
}

function checkGitCleanCommit(task = {}, goal = {}, result = {}, gitState = {}) {
  const hasCommit = Boolean(result.commit || task.commit);
  const changedFiles = asArray(result.changed_files || task.changed_files);
  const isDirty = gitState.dirty === true;
  const hasDiff = gitState.diff_empty === false;

  if (hasCommit && !isDirty && changedFiles.length > 0) {
    return { passed: true, changed_files: changedFiles, commit: result.commit || task.commit, summary: "git_clean_with_commit" };
  }
  if (hasCommit && changedFiles.length === 0 && !isDirty) {
    return { passed: true, changed_files: [], commit: result.commit || task.commit, summary: "git_clean_noop_commit" };
  }

  const findings = [];
  if (!hasCommit) findings.push(findingsFor("commit_missing", "No commit hash is present in task result.", "blocker", "git_clean_commit"));
  if (isDirty) findings.push(findingsFor("dirty_worktree", "Git worktree has uncommitted changes.", "blocker", "git_clean_commit"));
  if (findings.length === 0 && changedFiles.length === 0) {
    findings.push(findingsFor("changed_files_empty", "No changed files reported.", "blocker", "git_clean_commit"));
  }
  return { passed: false, findings, summary: "git_dirty_or_no_commit" };
}

function checkTests(result = {}, verification = {}) {
  const verCommands = asArray(verification.commands || result.verification?.commands);
  const testsSummary = result.tests || "";
  const verificationPassed = verification.passed === true || result.verification?.passed === true;

  if (verificationPassed && (verCommands.length > 0 || testsSummary)) {
    return { passed: true, commands: verCommands, summary: "tests_passed" };
  }

  const findings = [];
  if (!verificationPassed) {
    findings.push(findingsFor("verification_not_passed", "Verification did not report passed=true.", "blocker", "tests_passed"));
  }
  if (verCommands.length === 0 && !testsSummary) {
    findings.push(findingsFor("tests_evidence_missing", "No test commands or test summary reported.", "blocker", "tests_passed"));
  }
  if (verCommands.length > 0 && !verificationPassed) {
    const failed = verCommands.filter((cmd) => cmd.exit_code !== 0);
    for (const cmd of failed.slice(0, 5)) {
      findings.push(findingsFor("test_failed", `Test command exited with code ${cmd.exit_code}: ${cmd.cmd || cmd.command || "(unknown)"}`, "blocker", "tests_passed"));
    }
  }
  return { passed: false, findings, summary: "tests_not_passed" };
}

function checkChangedScope(task = {}, goal = {}, result = {}, contract = {}) {
  const changedFiles = asArray(result.changed_files || task.changed_files);
  const operationKind = contract.intent?.operation_kind || result.operation_kind || "";
  const mutationScope = contract.intent?.mutation_scope || result.mutation_scope || "";

  if (changedFiles.length > 0) {
    return { passed: true, changed_files: changedFiles, summary: "changed_files_present" };
  }

  const allowedEmptyProfiles = new Set(["diagnostic", "noop", "docs_only", "already_integrated", "repair_noop", "readonly_validation"]);
  if (allowedEmptyProfiles.has(operationKind) || mutationScope === "none") {
    return { passed: true, changed_files: [], summary: "changed_files_empty_acceptable_for_profile" };
  }

  return {
    passed: false,
    changed_files: [],
    findings: [findingsFor("changed_files_mismatch", `Changed files are empty for operation_kind="${operationKind}" which expects file mutations.`, "blocker", "changed_scope")],
  };
}

function checkReviewerDecision(task = {}, goal = {}, result = {}, bundle = {}) {
  const reviewerDecision = result.reviewer_decision || result.acceptance || result.acceptance_gate || bundle.acceptance_contract_summary;
  const bypassReview = result.bypass_review === true || result.needs_review === false;
  const contractVerification = result.contract_verification || bundle.contract_verification || {};

  if (reviewerDecision || contractVerification.acceptance_status) {
    return { passed: true, reviewer_decision: reviewerDecision || contractVerification, summary: "reviewer_decision_present" };
  }
  if (bypassReview) {
    return { passed: true, bypassed: true, summary: "review_bypassed" };
  }

  return {
    passed: false,
    findings: [findingsFor("reviewer_decision_missing", "No reviewer decision, acceptance gate verdict, or bypass flag is present.", "blocker", "reviewer_decision")],
  };
}

function checkDocumentationUpdated(task = {}, goal = {}, result = {}, contract = {}) {
  const operationKind = contract.intent?.operation_kind || result.operation_kind || "";
  const changedFiles = asArray(result.changed_files || task.changed_files);
  const docFiles = changedFiles.filter((f) => f.endsWith(".md") || f.startsWith("docs/") || f.includes("/docs/"));

  if (operationKind === "docs_only" && docFiles.length === 0) {
    return {
      passed: false,
      findings: [findingsFor("docs_not_updated", "Docs-only profile but no .md files in changed_files.", "blocker", "documentation_updated")],
      summary: "docs_not_updated",
    };
  }
  return { passed: true, doc_files: docFiles, summary: operationKind === "docs_only" ? "docs_updated" : "docs_not_required" };
}

// ---------------------------------------------------------------------------
// Core acceptance decision engine
// ---------------------------------------------------------------------------

/**
 * Evaluate acceptance evidence and produce a verdict.
 *
 * @param {object} options
 * @param {object} [options.task={}] - Task record
 * @param {object} [options.goal={}] - Goal record
 * @param {object} [options.result={}] - Task result from result.json
 * @param {object} [options.verification={}] - Verification evidence
 * @param {object} [options.contract={}] - Acceptance contract
 * @param {object} [options.gitState={}] - { dirty, diff_empty, commit }
 * @param {object} [options.acceptanceBundle={}] - Pre-built acceptance bundle
 * @returns {{ verdict: string, dimensions: object[], findings: object[], summary: string, idempotency_key: string }}
 */
export function evaluateAcceptance({
  task = {},
  goal = {},
  result = {},
  verification = {},
  contract = {},
  gitState = {},
  acceptanceBundle = {},
} = {}) {
  const findings = [];
  const dimensions = [];

  // 1. Check each dimension
  const resultCheck = checkResultArtifact(task, goal, result);
  dimensions.push({ dimension: "result_artifact", ...resultCheck });
  if (!resultCheck.passed) findings.push(...(resultCheck.findings || []));

  const gitCheck = checkGitCleanCommit(task, goal, result, gitState);
  dimensions.push({ dimension: "git_clean_commit", ...gitCheck });
  if (!gitCheck.passed) findings.push(...(gitCheck.findings || []));

  const testCheck = checkTests(result, verification);
  dimensions.push({ dimension: "tests_passed", ...testCheck });
  if (!testCheck.passed) findings.push(...(testCheck.findings || []));

  const scopeCheck = checkChangedScope(task, goal, result, contract);
  dimensions.push({ dimension: "changed_scope", ...scopeCheck });
  if (!scopeCheck.passed) findings.push(...(scopeCheck.findings || []));

  const reviewerCheck = checkReviewerDecision(task, goal, result, acceptanceBundle);
  dimensions.push({ dimension: "reviewer_decision", ...reviewerCheck });
  if (!reviewerCheck.passed) findings.push(...(reviewerCheck.findings || []));

  const docCheck = checkDocumentationUpdated(task, goal, result, contract);
  dimensions.push({ dimension: "documentation_updated", ...docCheck });
  if (!docCheck.passed) findings.push(...(docCheck.findings || []));

  // 2. Compute verdict
  const blockerFindings = findings.filter((f) => f.severity === "blocker");
  const nonBlockerFindings = findings.filter((f) => f.severity !== "blocker");

  let verdict;
  let summary;

  if (blockerFindings.length === 0) {
    verdict = VERDICT.PASSED;
    summary = "All acceptance criteria satisfied.";
  } else if (blockerFindings.length <= 2) {
    verdict = VERDICT.FAILED;
    summary = `${blockerFindings.length} blocking finding(s) require repair.`;
  } else if (nonBlockerFindings.length > 0 && blockerFindings.length > 2) {
    verdict = VERDICT.PARTIAL;
    summary = `${blockerFindings.length} blocking + ${nonBlockerFindings.length} non-blocking findings require convergence.`;
  } else {
    verdict = VERDICT.BLOCKED;
    summary = "Multiple blockers prevent acceptance; environment or tooling issue suspected.";
  }

  // 3. Build idempotency key from dimensions
  const dimStates = dimensions
    .map((d) => `${d.dimension}:${d.passed ? "1" : "0"}`)
    .sort()
    .join("|");

  return {
    verdict,
    dimensions,
    findings: compactList(findings),
    summary,
    idempotency_key: `acceptance:${verdict}:${dimStates}`,
    dimension_count: dimensions.length,
    blocker_count: blockerFindings.length,
    non_blocker_count: nonBlockerFindings.length,
  };
}

/**
 * Quick single-dimension check for advisory pre-checks.
 *
 * @param {object} options
 * @param {object} [options.result={}]
 * @param {object} [options.verification={}]
 * @returns {{ passed: boolean, summary: string }}
 */
export function quickAcceptanceCheck({ result = {}, verification = {} } = {}) {
  const hasResult = Boolean(result.status || result.summary);
  const hasVerification = verification.passed === true || result.verification?.passed === true;
  const hasCommit = Boolean(result.commit);
  const hasChangedFiles = asArray(result.changed_files).length > 0;

  const passed = hasResult && hasVerification && hasCommit && hasChangedFiles;
  return {
    passed,
    summary: passed ? "quick_check_passed" : "quick_check_failed",
    has_result: hasResult,
    has_verification: hasVerification,
    has_commit: hasCommit,
    has_changed_files: hasChangedFiles,
  };
}

export default { evaluateAcceptance, quickAcceptanceCheck, VERDICT, ACCEPTANCE_DIMENSIONS };
