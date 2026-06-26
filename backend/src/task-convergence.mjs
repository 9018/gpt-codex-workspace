/**
 * task-convergence.mjs — Unified task convergence decision engine.
 *
 * P0: Central decision module for what happens after a Codex task finishes
 * execution. Replaces ad-hoc status logic scattered across the codebase.
 *
 * Core rules:
 *   accepted + verification passed + no blocker  ⇒ completed
 *   429/quota  ⇒ quota_wait, NO repair
 *   502/503/gateway ⇒ retry_wait, NO repair
 *   verification_failed/implementation_failed ⇒ repair
 *   result missing + no diff  ⇒ retry_wait
 *   result missing + diff  ⇒ waiting_for_review
 *   sync_only success  ⇒ completed (ignore empty changed_files)
 *   verification_only success  ⇒ completed (ignore missing tests)
 *   repair exhausted  ⇒ blocked/failed
 *
 * Integrates:
 *   - failure-classifier.mjs (structured classification)
 *   - task-retry.mjs (bounded retry/quota)
 *   - acceptance-agent.mjs (profile-aware acceptance)
 *   - repair-loop.mjs (repair lifecycle)
 *   - notification-service.mjs (lifecycle events)
 */

import { classifyFailureStructured, getFailureClassDefinition, failureClassIsTerminalNonRepairable } from "./failure-classifier.mjs";
import { determineRetryStatus, isRetryBudgetExhausted, getRetryExhaustedStatus } from "./task-retry.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONVERGENCE_STATUSES = {
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
  WAITING_FOR_REVIEW: "waiting_for_review",
  WAITING_FOR_REPAIR: "waiting_for_repair",
  WAITING_FOR_INTEGRATION: "waiting_for_integration",
  RETRY_WAIT: "retry_wait",
  QUOTA_WAIT: "quota_wait",
  RESTART_PENDING: "restart_pending",
};

export const CLOSURE_REASONS = {
  ACCEPTED: "accepted",
  ACCEPTED_STALE_REVIEW: "accepted_stale_review",
  VERIFICATION_ONLY: "verification_only_no_tests_needed",
  SYNC_ONLY: "sync_only_no_changes_needed",
  NETWORK_RETRY: "network_retry",
  QUOTA_WAIT: "quota_wait",
  REPAIR_CREATED: "repair_created",
  REPAIR_EXHAUSTED: "repair_exhausted",
  RESULT_MISSING_NO_DIFF: "result_missing_no_diff",
  RESULT_MISSING_WITH_DIFF: "result_missing_with_diff",
  INTEGRATION_DONE: "integration_done",
  INTEGRATION_PENDING: "integration_pending",
  RESTART_REQUIRED: "restart_required",
  UNKNOWN: "unknown",
};

// ---------------------------------------------------------------------------
// Acceptance profile detection
// ---------------------------------------------------------------------------

/**
 * Detect the acceptance profile for a task based on its properties and result.
 *
 * @param {object} task - Task object
 * @param {object} taskResult - Task result object
 * @returns {string} Profile name
 */
export function detectAcceptanceProfile(task = {}, taskResult = {}) {
  // Check for repair tasks first
  if (task.parent_task_id || task.repair_of_task_id) {
    if (hasChangedFiles(task, taskResult)) return "repair_code_change";
    return "repair_noop";
  }

  // Check for noop
  if (taskResult.noop === true || taskResult.kind === "noop" || task.mode === "noop") return "noop";

  // Check for sync-only: explicit mode, structured result, or repository-sync intent.
  // Real GPTWork sync tasks often run in ordinary builder mode, so relying only
  // on task.mode leaves them stuck on tests_missing review gates.
  if (task.mode === "sync" || task.mode === "github_sync") return task.mode === "github_sync" ? "github_sync_only" : "sync_only";
  if (looksLikeSyncOnlyTask(task, taskResult)) return "sync_only";

  // Check for verification-only: no changed files expected, just verification
  if (taskResult.verification_only === true || task.mode === "verification") return "verification_only";

  // Check for integration-only
  if (task.mode === "integration" || task.status === "waiting_for_integration") return "integration_only";

  // Check for network retry (task that was previously retrying)
  if (task.status === "retry_wait" || task.status === "quota_wait") return "network_retry";

  // Check for runtime change
  if (hasRuntimeChanges(task, taskResult)) return "runtime_change";

  // Default: code_change if files changed
  if (hasChangedFiles(task, taskResult)) return "code_change";

  return "code_change";
}

function hasChangedFiles(task, taskResult) {
  const files = taskResult.changed_files || task.changed_files || (task.result && task.result.changed_files) || [];
  return Array.isArray(files) && files.length > 0;
}

function looksLikeSyncOnlyTask(task = {}, taskResult = {}) {
  if (hasChangedFiles(task, taskResult)) return false;
  const text = String([task.title, task.description, taskResult.summary, taskResult.kind].filter(Boolean).join(" ")).toLowerCase();
  const hasSyncIntent = /\b(sync|synchroni[sz]e|remote|origin\/main|ahead\/behind|local_head|remote_head)\b/.test(text) ||
    text.includes("同步") || text.includes("远端");
  if (!hasSyncIntent) return false;
  const hasRepoEvidence = taskResult.verification?.passed === true ||
    Boolean(taskResult.remote_head) ||
    Boolean(taskResult.commit) ||
    text.includes("ahead") || text.includes("behind") || text.includes("local=remote");
  return hasRepoEvidence;
}

function hasRuntimeChanges(task, taskResult) {
  if (task.mode === "deploy") return true;
  const files = taskResult.changed_files || task.changed_files || [];
  if (!Array.isArray(files)) return false;
  return files.some(f =>
    f.startsWith("backend/src/") || f.startsWith("src/") ||
    f.includes("worker") || f.includes("runtime") || f.includes("server")
  );
}

// ---------------------------------------------------------------------------
// Core convergence decision
// ---------------------------------------------------------------------------

/**
 * Make the convergence decision for a task after execution.
 *
 * This is the single entry point for determining what happens next.
 *
 * @param {object} options
 * @param {object} options.task - Task object
 * @param {object} options.taskResult - Task result object
 * @param {object} [options.acceptance] - Acceptance result from acceptance agent
 * @param {object} [options.evidence] - Verification evidence
 * @param {object} [options.failureClassStructured] - Pre-classified failure (optional)
 * @param {object} [options.repoState] - Repository state (local_head, remote_head, etc.)
 * @param {object} [options.githubState] - GitHub sync state
 * @param {object} [options.notificationState] - Notification state
 * @param {object} [options.runtimeState] - Runtime state (running_commit, repo_head)
 * @param {number} [options.attempt=0] - Current attempt count
 * @param {boolean} [options.hasWorktreeDiff] - Whether worktree has uncommitted changes
 * @param {string} [options.now] - ISO timestamp
 * @returns {{
 *   nextStatus: string,
 *   reason: string,
 *   closureReason: string,
 *   profile: string,
 *   findings: Array,
 *   notifications: Array,
 *   githubWriteback: object|null,
 *   repairPlan: object|null,
 *   retryPlan: object|null,
 *   restartPlan: object|null,
 * }}
 */
export function convergeTaskAfterRun({
  task = {},
  taskResult = {},
  acceptance,
  evidence,
  failureClassStructured,
  repoState = {},
  githubState = {},
  notificationState = {},
  runtimeState = {},
  attempt = 0,
  hasWorktreeDiff = false,
  now,
} = {}) {
  const findings = [];
  const notifications = [];
  const profile = detectAcceptanceProfile(task, taskResult);
  const timestamp = now || new Date().toISOString();

  // ---- Step 1: Classify failure if not provided ----
  // Use taskResult.failure_class if already classified (preferred path)
  // This handles provider_interruption, execution_timeout, etc. that classifyFailure
  // may not recognize from message alone.
  let fc;
  if (failureClassStructured) {
    fc = failureClassStructured;
  } else if (taskResult.failure_class) {
    // Look up the definition directly from the structured map
    // Falls back to unknown if not found
    const def = getFailureClassDefinition(taskResult.failure_class);
    if (def) {
      fc = { ...def, evidence: [] };
    } else {
      fc = classifyFailureStructured({
        resultJson: taskResult,
        result: taskResult,
        message: taskResult.summary || "",
      });
    }
  } else {
    fc = classifyFailureStructured({
      resultJson: taskResult,
      result: taskResult,
      message: taskResult.summary || "",
    });
  }

  // ---- Step 2: Check if task status is already terminal ----
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return {
      nextStatus: task.status,
      reason: `Task already in terminal state: ${task.status}`,
      closureReason: task.status,
      profile,
      findings,
      notifications: [],
      githubWriteback: null,
      repairPlan: null,
      retryPlan: null,
      restartPlan: null,
    };
  }

  // ---- Step 3: Network/transient failures → retry or quota ----
  if (taskResult.failure_class && failureClassIsTerminalNonRepairable(taskResult.failure_class)) {
    const retryDecision = determineRetryStatus({
      taskResult,
      attempt,
      failureClass: taskResult.failure_class,
    });

    if (retryDecision.status === "quota_wait" || retryDecision.status === "retry_wait") {
      return {
        nextStatus: retryDecision.status,
        reason: retryDecision.reason,
        closureReason: retryDecision.failureClass,
        profile,
        findings: [{ severity: "major", code: retryDecision.failureClass, message: retryDecision.reason, source: "task_convergence" }],
        notifications: [{ event: retryDecision.status === "quota_wait" ? "task_quota_wait" : "task_retry_wait", taskId: task.id, attempt, timestamp }],
        githubWriteback: { action: "comment", body: `Task moved to ${retryDecision.status}: ${retryDecision.reason}` },
        repairPlan: null,
        retryPlan: { delay: computeRetryDelay(retryDecision.failureClass, attempt), maxAttempts: getMaxRetries(retryDecision.failureClass), currentAttempt: attempt },
        restartPlan: null,
      };
    }

    // Budget exhausted
    return {
      nextStatus: retryDecision.status,
      reason: retryDecision.reason,
      closureReason: retryDecision.failureClass,
      profile,
      findings: [{ severity: "blocker", code: retryDecision.failureClass, message: retryDecision.reason, source: "task_convergence" }],
      notifications: [{ event: "task_failed", taskId: task.id, failureClass: retryDecision.failureClass, timestamp }],
      githubWriteback: { action: "comment", body: `Task failed: ${retryDecision.reason}` },
      repairPlan: null,
      retryPlan: { exhausted: true, maxAttempts: getMaxRetries(retryDecision.failureClass), currentAttempt: attempt },
      restartPlan: null,
    };
  }

  // ---- Step 4: Check acceptance ----
  const acceptancePassed = acceptance && (acceptance.passed === true || acceptance.status === "accepted" || acceptance.status === "accepted_with_followups");
  const verificationPassed = taskResult.verification?.passed === true;
  const acceptanceFindings = (acceptance && acceptance.findings) || taskResult.acceptance_findings || [];
  const blockerFindings = acceptanceFindings.filter(f => f.severity === "blocker" || f.severity === "major");

  // For profiles that don't require verification (noop, sync, verification_only),
  // verification is optional — treat missing verification as "passing"
  const profilesRequiringVerification = ["code_change", "runtime_change", "repair_code_change", "deploy", "docs_only", "config_change"];
  const verificationRequired = profilesRequiringVerification.includes(profile);
  const effectiveVerificationPassed = verificationPassed || !verificationRequired;

  if (acceptancePassed && effectiveVerificationPassed && blockerFindings.length === 0) {
    // ---- Step 4a: Accepted + verified + no blockers → check runtime ----
    const hasRuntimeChanges = needRuntimeRestart(runtimeState) || task.mode === "deploy" || task.mode === "runtime_change";
    if (hasRuntimeChanges) {
      return {
        nextStatus: CONVERGENCE_STATUSES.RESTART_PENDING,
        reason: "Acceptance passed, verification passed. Runtime code changed — restart required.",
        closureReason: CLOSURE_REASONS.RESTART_REQUIRED,
        profile,
        findings,
        notifications: [{ event: "restart_required", taskId: task.id, timestamp }],
        githubWriteback: { action: "status", status: "restart_pending" },
        repairPlan: null,
        retryPlan: null,
        restartPlan: { required: true, runningCommit: runtimeState.runningCommit || runtimeState.running_commit, repoHead: runtimeState.repo_head },
      };
    }

    return {
      nextStatus: CONVERGENCE_STATUSES.COMPLETED,
      reason: "Acceptance passed, verification passed, no blockers. Auto-completing.",
      closureReason: CLOSURE_REASONS.ACCEPTED,
      profile,
      findings,
      notifications: [{ event: "task_completed", taskId: task.id, timestamp }],
      githubWriteback: { action: "close", status: "completed" },
      repairPlan: null,
      retryPlan: null,
      restartPlan: null,
    };
  }

  // ---- Step 4b: Sync-only / verification-only / noop acceptance ----
  // These profiles should NOT be blocked by tests_missing or changed_files_mismatch.
  // When ALL blocker findings are non-blockers for the profile, complete regardless
  // of acceptance.passed value — the acceptance agent doesn't know about profiles.
  if (blockerFindings.length > 0) {
    const allNonBlockerForProfile = blockerFindings.every(f =>
      isNonBlockerForProfile(f.code, profile)
    );
    if (allNonBlockerForProfile) {
      const reasonStr = profile + ": non-blocker findings only (" + blockerFindings.map(function(f) { return f.code; }).join(", ") + "). Auto-completing.";
      return {
        nextStatus: CONVERGENCE_STATUSES.COMPLETED,
        reason: reasonStr,
        closureReason: profile === "sync_only" || profile === "github_sync_only" || profile === "noop" ? CLOSURE_REASONS.SYNC_ONLY : CLOSURE_REASONS.VERIFICATION_ONLY,
        profile: profile,
        findings: blockerFindings,
        notifications: [{ event: "task_completed", taskId: task.id, timestamp: timestamp }],
        githubWriteback: { action: "close", status: "completed" },
        repairPlan: null,
        retryPlan: null,
        restartPlan: null,
      };
    }
  }

  // ---- Step 5: Verification failures / implementation failures → repair ----
  if (fc.repairable || taskResult.verification?.passed === false) {
    // Check repair budget separately for repairable failures
    const maxRepairAttempts = task.max_attempts || task.maxAttempts || 2;
    const currentRepairAttempt = task.repair_attempt || 0;
    const repairBudgetExhausted = currentRepairAttempt >= maxRepairAttempts;

    if (repairBudgetExhausted) {
      return {
        nextStatus: "blocked",
        reason: "Repair budget exhausted: " + currentRepairAttempt + "/" + maxRepairAttempts + " attempts for " + fc.class,
        closureReason: CLOSURE_REASONS.REPAIR_EXHAUSTED,
        profile,
        findings: blockerFindings,
        notifications: [{ event: "task_failed", taskId: task.id, failureClass: fc.class, timestamp }],
        githubWriteback: { action: "comment", body: "Repair exhausted: " + currentRepairAttempt + "/" + maxRepairAttempts },
        repairPlan: { exhausted: true, attempt: currentRepairAttempt },
        retryPlan: null,
        restartPlan: null,
      };
    }

    const repairAttempt = currentRepairAttempt + 1;
    return {
      nextStatus: CONVERGENCE_STATUSES.WAITING_FOR_REPAIR,
      reason: "Repairable failure (" + fc.class + ") — attempt " + repairAttempt + "/" + maxRepairAttempts,
      closureReason: CLOSURE_REASONS.REPAIR_CREATED,
      profile,
      findings: blockerFindings,
      notifications: [{ event: "task_waiting_for_repair", taskId: task.id, repairAttempt, timestamp }],
      githubWriteback: { action: "status", status: "waiting_for_repair" },
      repairPlan: { attempt: repairAttempt, findings: blockerFindings, proposals: (acceptance && acceptance.repair_proposals) || [] },
      retryPlan: null,
      restartPlan: null,
    };
  }

  // ---- Step 6: Result missing scenarios ----
  const resultJsonMissing = !taskResult.status && !taskResult.kind && !taskResult.failure_class;
  if (resultJsonMissing) {
    if (hasWorktreeDiff) {
      return {
        nextStatus: CONVERGENCE_STATUSES.WAITING_FOR_REVIEW,
        reason: "Result.json missing but worktree has diff. Needs review/integration.",
        closureReason: CLOSURE_REASONS.RESULT_MISSING_WITH_DIFF,
        profile,
        findings: [{ severity: "major", code: "result_missing", message: "Result.json missing but worktree has changes", source: "task_convergence" }],
        notifications: [{ event: "task_waiting_for_review", taskId: task.id, timestamp }],
        githubWriteback: { action: "status", status: "waiting_for_review" },
        repairPlan: null,
        retryPlan: null,
        restartPlan: null,
      };
    }

    return {
      nextStatus: CONVERGENCE_STATUSES.RETRY_WAIT,
      reason: "Result.json missing and no worktree diff. Retrying.",
      closureReason: CLOSURE_REASONS.RESULT_MISSING_NO_DIFF,
      profile,
      findings: [{ severity: "major", code: "result_missing", message: "Result.json missing with no worktree diff", source: "task_convergence" }],
      notifications: [{ event: "task_retry_wait", taskId: task.id, timestamp }],
      githubWriteback: { action: "comment", body: "Result.json missing — retrying." },
      repairPlan: null,
      retryPlan: { delay: 5000, maxAttempts: 2, currentAttempt: attempt },
      restartPlan: null,
    };
  }

  // ---- Step 7: Default fallback: review ----
  return {
    nextStatus: CONVERGENCE_STATUSES.WAITING_FOR_REVIEW,
    reason: `Unhandled convergence case: profile=${profile}, fc=${fc.class}, acceptance=${acceptance?.status}, blockers=${blockerFindings.length}`,
    closureReason: CLOSURE_REASONS.UNKNOWN,
    profile,
    findings: blockerFindings,
    notifications: [{ event: "task_waiting_for_review", taskId: task.id, timestamp }],
    githubWriteback: { action: "status", status: "waiting_for_review" },
    repairPlan: null,
    retryPlan: null,
    restartPlan: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonBlockerForProfile(code, profile) {
  if (code === "tests_missing") {
    return ["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop", "network_retry"].includes(profile);
  }
  if (code === "changed_files_mismatch") {
    return ["sync_only", "github_sync_only", "verification_only", "noop", "repair_noop"].includes(profile);
  }
  return false;
}

function acceptanceStatusIsOk(acceptance) {
  if (!acceptance) return false;
  if (acceptance.passed === true) return true;
  if (acceptance.status === "accepted" || acceptance.status === "accepted_with_followups") return true;
  return false;
}

function needRuntimeRestart(runtimeState) {
  if (!runtimeState) return false;
  const { runningCommit, repoHead, runtimeChanged } = runtimeState;
  if (runtimeChanged === true) return true;
  if (runningCommit && repoHead && runningCommit !== repoHead) return true;
  return false;
}

function computeRetryDelay(failureClass, attempt) {
  const baseDelays = {
    rate_limited: 30_000,
    quota_exceeded: 60_000,
    gateway_error: 10_000,
    service_unavailable: 10_000,
    transient_network_error: 5_000,
    provider_interruption: 15_000,
    execution_timeout: 30_000,
    startup_timeout: 10_000,
    result_missing: 5_000,
  };
  const base = baseDelays[failureClass] || 10_000;
  return Math.min(base * Math.pow(2, attempt), 300_000);
}

function getMaxRetries(failureClass) {
  const maxRetries = {
    rate_limited: 3,
    quota_exceeded: 2,
    gateway_error: 3,
    service_unavailable: 3,
    transient_network_error: 2,
    provider_interruption: 2,
    execution_timeout: 1,
    startup_timeout: 2,
    result_missing: 1,
  };
  return maxRetries[failureClass] || 2;
}

// ---------------------------------------------------------------------------
// Consolidation: finalize a set of convergence decisions across tasks
// ---------------------------------------------------------------------------

/**
 * Consolidate convergence decisions across multiple tasks.
 *
 * Used by the worker loop after processing a batch of tasks.
 * Checks for overall queue health and stale states.
 *
 * @param {Array<object>} decisions - Array of convergence decisions
 * @returns {{ healthy: boolean, staleReviewCount: number, staleRepairCount: number, staleIntegrationCount: number, recommendations: Array }}
 */
export function consolidateBatchConvergence(decisions = []) {
  let staleReviewCount = 0;
  let staleRepairCount = 0;
  let staleIntegrationCount = 0;
  const recommendations = [];

  for (const d of decisions) {
    if (d.nextStatus === "waiting_for_review") staleReviewCount++;
    if (d.nextStatus === "waiting_for_repair") staleRepairCount++;
    if (d.nextStatus === "waiting_for_integration") staleIntegrationCount++;
  }

  return {
    healthy: staleReviewCount === 0 && staleRepairCount === 0 && staleIntegrationCount === 0,
    staleReviewCount,
    staleRepairCount,
    staleIntegrationCount,
    recommendations,
  };
}
