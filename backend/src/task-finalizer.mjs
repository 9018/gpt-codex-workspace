import { classifyNoChangeRepairOutcome } from './no-change-repair-classifier.mjs';

// P0-MA22: No-mutation profile set — tasks where changed_files=[] is a
// legitimate terminal state and integration is not meaningful.
const NO_MUTATION_PROFILES = new Set([
  'diagnostic', 'noop', 'readonly_validation', 'already_integrated',
  'repair_noop', 'network_retry', 'verification_only', 'sync_only',
  'github_sync_only', 'docs_only', 'docs_only',
]);
import { createReviewStateBlock } from './task-review-status-taxonomy.mjs';
import { normalizeToUnifiedDecision } from './codex-unified-decision.mjs';


const FINALIZER_STATUSES = new Set([
  "completed",
  "waiting_for_integration",
  "waiting_for_repair",
  "waiting_for_capacity",
  "waiting_for_review",
  "waiting_for_human_review",
  "waiting_for_missing_evidence_repair",
  "waiting_for_integration_recovery",
  "waiting_for_result_contract_repair",
  "waiting_for_noop_evidence",
  "waiting_for_manual_terminal_decision",
  "human_interrupted_for_repair_budget_exhausted",
  "timed_out",
  "failed",
]);

const CAPACITY_PATTERNS = [
  /\b429\b/i,
  /rate[_ -]?limit(?:ed|_exceeded)?/i,
  /too many requests/i,
  /quota(?: exhausted| exceeded)?/i,
  /insufficient_quota/i,
  /billing(?: hard)? limit/i,
  /billing_hard_limit/i,
  /resource_exhausted/i,
  /capacity_exceeded/i,
];

const REPAIRABLE_FAILURE_CLASSES = new Set([
  "missing_result_json",
  "result_missing",
  "invalid_result_json",
  "verification_failed",
  "verification_not_passed",
  "verification_command_failed",
  "test_failed",
  "build_failed",
  "lint_failed",
  "typecheck_failed",
  "git_diff_check_failed",
  "first_output_timeout",
  "no_first_output_timeout",
  "acceptance_failed",
]);

const REPAIRABLE_INTEGRATION_STATUSES = new Set(["conflict", "check_failed", "push_failed", "pr_failed"]);
const TERMINAL_INTEGRATION_STATUSES = new Set(["merged", "ff_only_merged", "skipped", "not_required", "already_integrated"]);
const NON_TERMINAL_INTEGRATION_STATUSES = new Set(["branch_pushed", "pr_opened", "pending", "queued", "locked", "waiting"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function compactStrings(values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .filter((value) => value && value !== "{}" && value !== "[]");
}

function textEvidence(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const verification = asObject(evidence.verification || result.verification);
  const integration = asObject(evidence.integration || result.integration);
  const runtimeGuard = asObject(evidence.runtime_guard || result.runtime_guard || result.restart_guard);
  const failure = asObject(evidence.failure || result.failure);
  return compactStrings([
    evidence.reason,
    evidence.error,
    result.reason,
    result.summary,
    result.stderr,
    result.error,
    result.failure_class,
    result.kind,
    verification.reason,
    verification.failure_class,
    integration.status,
    integration.error,
    runtimeGuard.reason,
    runtimeGuard.error,
    failure.reason,
    failure.failure_class,
  ]).join("\n");
}

function hasCapacityFailure(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const failureClass = String(result.failure_class || evidence.failure_class || evidence.failure?.failure_class || "");
  if (["quota_exhausted", "quota_exhausted_or_rate_limited", "rate_limited", "insufficient_quota"].includes(failureClass)) return true;
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(textEvidence(evidence)));
}

function blocker(code, message, evidence = {}, source = "task_finalizer") {
  return { severity: "blocker", code, message, source, evidence };
}

function followupsFrom(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const contract = asObject(evidence.contract_verification || result.contract_verification || result.verification?.contract_verification);
  return [
    ...list(result.non_blocking_followups),
    ...list(result.followup_findings),
    ...list(result.followups),
    ...list(contract.non_blocking_followups),
    ...list(contract.quality_notes),
  ];
}

function unresolvedFindings(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const verification = asObject(evidence.verification || result.verification);
  const acceptance = asObject(evidence.acceptance || result.acceptance_gate || result.acceptance);
  return [
    ...list(result.acceptance_findings),
    ...list(result.findings),
    ...list(verification.findings),
    ...list(acceptance.findings),
  ].filter((finding) => finding?.resolved !== true && (finding?.severity === "blocker" || finding?.severity === "major"));
}

function verificationPassed(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const verification = asObject(evidence.verification || result.verification || result.final_verification);
  if (verification.passed === true) return true;
  if (result.final_verification?.passed === true) return true;
  if (result.verification?.passed === true) return true;
  if (result.auto_integration_completion?.completed === true && result.auto_integration_completion?.verification_report?.passed !== false) return true;
  return false;
}

function verificationFailed(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const verification = asObject(evidence.verification || result.verification || result.final_verification);
  return verification.passed === false || result.verification?.passed === false || result.final_verification?.passed === false;
}

function acceptancePassed(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const acceptance = asObject(evidence.acceptance || result.acceptance_gate || result.acceptance);
  const reviewer = asObject(result.reviewer_decision);
  if (acceptance.passed === true || acceptance.status === "accepted" || acceptance.task_status === "completed") return true;
  if (acceptance.closure_decision?.blocking_passed === true && acceptance.closure_decision?.requires_human_decision !== true) return true;
  if (reviewer.passed === true || reviewer.status === "accepted" || reviewer.decision === "accepted") return true;
  if (reviewer.decision?.passed === true || reviewer.decision?.status === "accepted" || reviewer.decision?.decision === "accepted") return true;
  if (result.requires_review !== true && verificationPassed(evidence) && unresolvedFindings(evidence).length === 0) return true;
  return false;
}

function contractBlockingPassed(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const contract = asObject(evidence.contract_verification || result.contract_verification || result.verification?.contract_verification);
  if (contract.blocking_passed === false || contract.completion_eligible === false) return false;
  if (list(contract.blockers).some((entry) => entry?.resolved !== true)) return false;
  return true;
}

function manualReviewBlockers(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const contract = asObject(evidence.contract_verification || result.contract_verification || result.verification?.contract_verification);
  const runtimeGuard = asObject(evidence.runtime_guard || result.runtime_guard || result.restart_guard || result.runtime);
  const blockers = [];

  if (contract.contract_valid === false) blockers.push(blocker("contract_invalid", "Acceptance contract is invalid.", contract, "contract_verifier"));
  if (contract.semantic_ambiguity === true || contract.acceptance_status === "indeterminate") blockers.push(blocker("semantic_ambiguity", "Acceptance semantics are ambiguous.", contract, "contract_verifier"));
  if (contract.requires_review === true && contract.blocking_passed !== true && !hasRepairPath(evidence)) blockers.push(blocker("contract_requires_review", "Contract verifier requires review.", contract, "contract_verifier"));
  if (runtimeGuard.manual_approval_required === true || runtimeGuard.unsafe_operation === true) blockers.push(blocker("manual_approval_required", runtimeGuard.reason || "Manual approval is required.", runtimeGuard, "runtime_guard"));
  if (result.state_corruption === true) blockers.push(blocker("state_corruption", "Task state corruption requires review.", result, "task_finalizer"));
  return blockers;
}

function hasRepairPath(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const closure = asObject(result.closure_decision);
  const evTask = asObject(evidence.task);

  // If the repair outcome was already resolved by handleRepairCompletion,
  // the path is no longer active -- return false to prevent the finalizer
  // P0: Prevent recursive waiting_for_repair loops on repair tasks.
  // A repair task (parent_task_id set) must NOT treat its OWN closure
  // decision of waiting_for_repair as an active external repair path.
  // Without this guard a repair task with no changed files would have
  // hasRepairPath return true → finalizer returns waiting_for_repair
  // → handleRepairCompletion never called → parent stays stuck forever.
  const isRepairTask = !!(evTask.parent_task_id || evTask.repair_of_task_id);
  if (isRepairTask && (closure.status === "waiting_for_repair" || closure.task_status === "waiting_for_repair"))
    return false;
  // from re-entering waiting_for_repair on stale metadata.
  const terminalRepairOutcomes = new Set(["repaired", "continued", "budget_exhausted", "failed"]);
  if (terminalRepairOutcomes.has(String(result.repair_outcome || "").toLowerCase())) return false;
  if (String(result.repair_status || "").toLowerCase() === "completed") return false;

  return result.repair_goal_id
    || result.repair_task_id
    || result.repair_goal
    || closure.status === "waiting_for_repair"
    || closure.task_status === "waiting_for_repair";
}

function repairDenied(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  return Boolean(result.repair_denied_reason);
}

function integrationRequired(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const integration = asObject(evidence.integration || result.integration);
  const contract = asObject(evidence.contract_verification || result.contract_verification || result.verification?.contract_verification);
  if (integration.required === true || result.needs_integration === true) return true;
  if (contract.requires_integration === true || result.acceptance_contract?.requirements?.requires_integration === true) return true;
  // P0-MA2: noop-like operations (readonly, already_integrated, noop) do not require integration
  if (result.integration_not_required === true || result.noop_result === true || result.readonly_result === true || result.already_integrated_result === true) return false;
  if (Array.isArray(result.changed_files) && result.changed_files.length > 0 && result.commit) {
    // Check operation_kind to avoid false positives
    const noopLikeKinds = NO_MUTATION_PROFILES;
    if (!noopLikeKinds.has(result.operation_kind)) return true;
  }
  return false;
}

function integrationSatisfied(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const integration = asObject(evidence.integration || result.integration);
  const autoCompletion = asObject(result.auto_integration_completion);
  if (!integrationRequired(evidence)) return true;
  if (integration.satisfied === true || integration.merged === true || integration.auto_completed === true) return true;
  if (autoCompletion.completed === true && autoCompletion.verification_report?.passed !== false) return true;
  return TERMINAL_INTEGRATION_STATUSES.has(String(integration.status || "").toLowerCase());
}

function noChangeRepairCompletion(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  return classifyNoChangeRepairOutcome({ task: evidence.task || {}, taskResult: result, result, integrationResult: evidence.integration || result.integration || {} });
}

function integrationNonTerminal(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const integration = asObject(evidence.integration || result.integration);
  if (!integrationRequired(evidence) || integrationSatisfied(evidence)) return false;
  const status = String(integration.status || "").toLowerCase();
  return !status || NON_TERMINAL_INTEGRATION_STATUSES.has(status) || integration.ok === true;
}

function repairAttemptsRemaining(evidence = {}) {
  const budget = asObject(evidence.repair_budget);
  if (Number.isInteger(budget.attempts_remaining)) return budget.attempts_remaining > 0;
  if (Number.isFinite(Number(budget.attempts_remaining))) return Number(budget.attempts_remaining) > 0;
  if (Number.isInteger(budget.attempt) && Number.isInteger(budget.max_attempts)) return budget.attempt + 1 < budget.max_attempts;
  if (Number.isInteger(evidence.task?.attempt) && Number.isInteger(evidence.task?.max_attempts)) return evidence.task.attempt + 1 < evidence.task.max_attempts;
  return true;
}

function repairableEvidence(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const verification = asObject(evidence.verification || result.verification || result.final_verification);
  const integration = asObject(evidence.integration || result.integration);
  const repairProposals = list(result.repair_proposals || evidence.repair_proposals);
  const closure = asObject(result.closure_decision);
  const failureClass = String(verification.failure_class || result.failure_class || evidence.failure_class || "");
  const blockers = [];

  if (hasRepairPath(evidence)) {
    blockers.push(blocker("repair_path_created", result.reason || closure.reason || "A repair path has been created for this task.", {
      repair_goal_id: result.repair_goal_id || null,
      repair_task_id: result.repair_task_id || null,
      closure_decision: closure,
    }, "repair_loop"));
  }
  const codexFailedWithProposal = result.kind === "codex_failed" && repairProposals.length > 0;

  if (codexFailedWithProposal) {
    blockers.push(blocker("codex_failed", result.summary || "Codex failed with repair proposals.", { repair_proposals: repairProposals }, "codex_result"));
  }
  if (!codexFailedWithProposal && verificationFailed(evidence) && (REPAIRABLE_FAILURE_CLASSES.has(failureClass) || failureClass === "")) {
    blockers.push(blocker(failureClass || "verification_failed", "Verification failed and can be repaired.", verification, "verifier"));
  }
  if (REPAIRABLE_INTEGRATION_STATUSES.has(String(integration.status || "").toLowerCase())) {
    blockers.push(blocker(`integration_${integration.status}`, integration.error || "Integration failure is repairable.", integration, "integration_queue"));
  }
  for (const entry of list(closure.repairable_blockers)) {
    blockers.push(blocker(entry.code || "repairable_closure_blocker", entry.message || closure.reason || "Closure decision has repairable blockers.", entry, entry.source || "closure_decider"));
  }
  return blockers;
}

function terminalFailedEvidence(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const currentStatus = String(evidence.current_status || result.status || "");
  const findings = [
    ...list(result.acceptance_findings),
    ...list(result.findings),
    ...list(evidence.verification?.findings),
  ];
  if (currentStatus === "timed_out" || result.kind === "codex_timeout") return "timed_out";
  if (currentStatus !== "failed" && result.status !== "failed") return null;
  if (result.kind === "worktree_cleanup_failed" || result.failure_class === "worktree_cleanup_failed") return "failed";
  if (findings.some((finding) => finding?.code === "git_worktree_cleanup_failed")) return "failed";
  if (result.kind === "codex_failed" && result.failure_class === "result_missing") return "failed";
  if (evidence.policy?.terminal_failed_when_unrecoverable === true) return "failed";
  if (!verificationFailed(evidence) && unresolvedFindings(evidence).length === 0 && !hasRepairPath(evidence)) return "failed";
  return null;
}

function existingHoldStatus(evidence = {}) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const currentStatus = String(evidence.current_status || result.status || "");
  if (currentStatus === "waiting_for_repair") return "waiting_for_repair";
  if (currentStatus === "waiting_for_integration") return "waiting_for_integration";
  return null;
}

function queueEffect(status, safeToAutoAdvance) {
  return {
    status,
    unblock_dependents: safeToAutoAdvance === true,
    hold_queue: safeToAutoAdvance !== true,
  };
}

function goalEffect(status, safeToAutoAdvance) {
  return {
    status,
    complete_goal: status === "completed",
    safe_to_auto_advance: safeToAutoAdvance === true,
  };
}

function integrationEffect(evidence = {}, status) {
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const integration = asObject(evidence.integration || result.integration);
  return {
    required: integrationRequired(evidence),
    status: status === "completed" && integrationSatisfied(evidence) ? "satisfied" : (integration.status || null),
    satisfied: integrationSatisfied(evidence),
    terminal: integrationSatisfied(evidence),
  };
}

function decision(evidence, { status, reason, blockers = [], repairableBlockers = [], safeToAutoAdvance = false } = {}) {
  const normalizedStatus = FINALIZER_STATUSES.has(status) ? status : "waiting_for_review";
  const reviewStateBlock = createReviewStateBlock({ reason, blockers, repairBudgetExhausted: reason === "repair_budget_exhausted" });
  const finalizerDecisionToNormalize = {
    status: normalizedStatus,
    reason: String(reason || "finalizer_decision"),
    blockers,
    repairable_blockers: repairableBlockers || [],
    safe_to_auto_advance: safeToAutoAdvance === true,
    blocking_passed: (blockers || []).length === 0 && (repairableBlockers || []).length === 0,
    integration_effect: integrationEffect(evidence, normalizedStatus),
    goal_effect: goalEffect(normalizedStatus, safeToAutoAdvance),
    queue_effect: queueEffect(normalizedStatus, safeToAutoAdvance),
  };
  const unifiedDecision = normalizeToUnifiedDecision({
    finalizerDecision: finalizerDecisionToNormalize,
    taskResult: evidence.codex_result || evidence.result || evidence.task_result || {},
    verification: evidence.verification || {},
    contractVerification: evidence.contract_verification || {},
  });
  return {
    status: normalizedStatus,
    reason: reason || "finalizer_decision",
    blockers,
    repairable_blockers: repairableBlockers,
    non_blocking_followups: followupsFrom(evidence),
    ...reviewStateBlock,
    integration_effect: integrationEffect(evidence, normalizedStatus),
    goal_effect: goalEffect(normalizedStatus, safeToAutoAdvance),
    queue_effect: queueEffect(normalizedStatus, safeToAutoAdvance),
    safe_to_auto_advance: safeToAutoAdvance === true,
    unified_decision: unifiedDecision,
  };
}



/**
 * Build completion checkpoint metadata for terminal success decisions.
 * This metadata is persisted before the finalizer declares terminal success
 * so that recovery/audit can verify the completion state even if downstream
 * writeback is interrupted.
 *
 * @param {object} evidence  - The evidence object passed to decideTaskFinalState
 * @param {object} decision  - The raw decision object from the decision() helper
 * @returns {object|null}    - Checkpoint object or null if not a terminal completion
 */
export function buildCompletionCheckpoint(evidence = {}, decision = {}) {
  if (decision.status !== 'completed') return null;
  const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
  const now = new Date().toISOString();
  return {
    checkpoint_type: 'completion',
    persisted_before_terminal: true,
    persisted_at: now,
    status: decision.status,
    reason: decision.reason,
    commit: result.commit || null,
    changed_files: Array.isArray(result.changed_files) ? [...result.changed_files] : [],
    blocking_passed: decision.blocking_passed === true,
    non_blocking_followups: decision.non_blocking_followups || [],
  };
}

export function decideTaskFinalState(evidence = {}) {
  if (hasCapacityFailure(evidence)) {
    return decision(evidence, {
      status: "waiting_for_capacity",
      reason: "external_capacity_failure",
      blockers: [blocker("external_capacity_failure", "External quota or rate-limit capacity failure.", { text: textEvidence(evidence) })],
    });
  }

  const semanticOrUnsafeBlockers = manualReviewBlockers(evidence);
  if (semanticOrUnsafeBlockers.some((entry) => entry.code === "semantic_ambiguity" || entry.code === "manual_approval_required" || entry.code === "state_corruption")) {
    return decision(evidence, { status: "waiting_for_review", reason: "manual_review_required", blockers: semanticOrUnsafeBlockers });
  }

  const unresolved = unresolvedFindings(evidence);
  const noChangeRepair = noChangeRepairCompletion(evidence);
  if (noChangeRepair.completion_eligible === true) {
    return decision(evidence, {
      status: "completed",
      reason: "no_change_repair_evidence_satisfied",
      safeToAutoAdvance: true,
    });
  }

  const terminalSatisfied = verificationPassed(evidence)
    && acceptancePassed(evidence)
    && contractBlockingPassed(evidence)
    && integrationSatisfied(evidence)
    && unresolved.length === 0;
  if (terminalSatisfied) {
    return decision(evidence, { status: "completed", reason: "terminal_evidence_satisfied", safeToAutoAdvance: true });
  }

  if (verificationPassed(evidence) && acceptancePassed(evidence) && contractBlockingPassed(evidence) && integrationNonTerminal(evidence) && unresolved.length === 0) {
    return decision(evidence, {
      status: "waiting_for_integration",
      reason: "integration_required_not_terminal",
      repairableBlockers: [blocker("integration_required_not_terminal", "Integration is required but has not reached terminal evidence.", asObject(evidence.integration || evidence.codex_result?.integration), "integration_queue")],
    });
  }

  const repairableBlockers = repairableEvidence(evidence);
  if (repairableBlockers.length > 0) {
    const isRepairTask = !!(evidence.task && (evidence.task.parent_task_id || evidence.task.repair_of_task_id));
    if (!isRepairTask && !repairDenied(evidence) && (hasRepairPath(evidence) || repairAttemptsRemaining(evidence))) {
      const codexFailed = repairableBlockers.some((entry) => entry.code === "codex_failed");
      return decision(evidence, {
        status: "waiting_for_repair",
        reason: codexFailed ? "codex_failed_repairable" : "repairable_failure",
        repairableBlockers,
      });
    }
    // Repair tasks must go to "failed" to trigger handleRepairCompletion propagation to parent.
    if (isRepairTask) {
      return decision(evidence, {
        status: "failed",
        reason: "repair_task_unrecoverable",
        blockers: repairableBlockers,
      });
    }
    return decision(evidence, {
      status: "waiting_for_review",
      reason: "repair_budget_exhausted",
      blockers: repairableBlockers,
    });
  }

  const terminalFailedStatus = terminalFailedEvidence(evidence);
  if (terminalFailedStatus) {
    const result = asObject(evidence.codex_result || evidence.result || evidence.task_result);
    return decision(evidence, {
      status: terminalFailedStatus,
      reason: terminalFailedStatus === "timed_out" ? "execution_timed_out" : "unrecoverable_execution_failure",
      blockers: [blocker("unrecoverable_execution_failure", result.summary || "Execution failed without a repair path.", result, "codex_result")],
    });
  }

  const holdStatus = existingHoldStatus(evidence);
  if (holdStatus === "waiting_for_repair") {
    // P0: Repair tasks stuck in existing_repair_hold must escape to "failed".
    const isRepairTask = !!(evidence.task && (evidence.task.parent_task_id || evidence.task.repair_of_task_id));
    if (isRepairTask) {
      return decision(evidence, {
        status: "failed",
        reason: "repair_task_unrecoverable_hold",
        blockers: [blocker("repair_task_hold_loop", "Repair task stuck in existing_repair_hold; terminating to unblock parent convergence.")],
      });
    }
    return decision(evidence, {
      status: "waiting_for_repair",
      reason: "existing_repair_hold",
      repairableBlockers: [blocker("existing_repair_hold", "Task is already waiting for repair and no stronger terminal evidence superseded it.")],
    });
  }
  if (holdStatus === "waiting_for_integration") {
    return decision(evidence, {
      status: "waiting_for_integration",
      reason: "existing_integration_hold",
      repairableBlockers: [blocker("existing_integration_hold", "Task is already waiting for integration and no stronger terminal evidence superseded it.")],
    });
  }

  const manualBlockers = manualReviewBlockers(evidence);
  if (manualBlockers.length > 0) {
    return decision(evidence, { status: "waiting_for_review", reason: "manual_review_required", blockers: manualBlockers });
  }

  return decision(evidence, {
    status: "waiting_for_review",
    reason: "manual_review_required",
    blockers: unresolved.length > 0 ? unresolved : [blocker("insufficient_terminal_evidence", "Finalizer could not prove completion, integration, repair, capacity, or failed terminal status.")],
  });
}

export function applyTaskFinalStateDecision({ taskStatus, taskResult = {}, finalizerDecision = {} } = {}) {
  const status = FINALIZER_STATUSES.has(finalizerDecision.status) ? finalizerDecision.status : taskStatus;
  const requiresReview = status === "completed"
    ? false
    : (status === "waiting_for_review"
      ? true
      : (finalizerDecision.review_state ? !finalizerDecision.machine_repairable : taskResult.requires_review === true));
  return {
    taskStatus: status,
    taskResult: {
      ...taskResult,
      status,
      finalizer_decision: finalizerDecision,
      requires_review: requiresReview,
      reason: finalizerDecision.reason || taskResult.reason,
      unified_decision: finalizerDecision.unified_decision || taskResult.unified_decision || null,
    },
  };

}
