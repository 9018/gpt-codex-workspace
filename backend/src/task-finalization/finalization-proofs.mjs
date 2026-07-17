export function attachResolvedWorktreeEvidence(taskResult = {}, resolvedRepo = null) {
  if (resolvedRepo?.worktree_lifecycle?.mode !== "git_worktree" || !resolvedRepo?.task_worktree_path) return taskResult;
  const lifecycle = {
    ...(taskResult.worktree_lifecycle || {}),
    ...(resolvedRepo.worktree_lifecycle || {}),
    worktree_path: taskResult.worktree_lifecycle?.worktree_path || resolvedRepo.task_worktree_path,
  };
  return {
    ...taskResult,
    worktree_lifecycle: lifecycle,
    repo_resolution: {
      ...(taskResult.repo_resolution || {}),
      repo_id: taskResult.repo_resolution?.repo_id || resolvedRepo.repo_id || null,
      canonical_repo_path: taskResult.repo_resolution?.canonical_repo_path || resolvedRepo.canonical_repo_path || null,
      task_worktree_path: taskResult.repo_resolution?.task_worktree_path || resolvedRepo.task_worktree_path,
      worktree_lifecycle: lifecycle,
    },
  };
}

export function buildFallbackResultJson({ taskStatus, taskResult = {}, summary = "" }) {
  const verifiedNoChange = taskStatus === "completed"
    && Array.isArray(taskResult.changed_files)
    && taskResult.changed_files.length === 0
    && !taskResult.commit
    && taskResult.verification?.passed === true;
  return {
    status: taskStatus,
    summary: taskResult.summary || summary || "",
    noop: taskResult.noop === true || verifiedNoChange,
    noop_reason: taskResult.noop_reason || (verifiedNoChange ? "No changed files were reported and verification passed." : null),
    no_mutation: taskResult.no_mutation === true || verifiedNoChange,
    repo_mutated: taskResult.repo_mutated === false || verifiedNoChange ? false : (taskResult.repo_mutated === true ? true : null),
    operation_kind: taskResult.operation_kind || taskResult.operationKind || taskResult.acceptance_contract?.intent?.operation_kind || (verifiedNoChange ? "noop" : null),
    acceptance_contract_id: taskResult.acceptance_contract_id || taskResult.acceptanceContractId || taskResult.acceptance_contract?.id || null,
    blocking_evidence: taskResult.blocking_evidence || null,
    changed_files: Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [],
    file_evidence: Array.isArray(taskResult.file_evidence) ? taskResult.file_evidence : [],
    restart_evidence: taskResult.restart_evidence || null,
    admin_evidence: taskResult.admin_evidence || null,
    diagnostic_evidence: taskResult.diagnostic_evidence || null,
    cleanup_evidence: taskResult.cleanup_evidence || null,
    tests: taskResult.tests || null,
    commit: taskResult.commit || null,
    local_head: taskResult.local_head || null,
    remote_head: taskResult.remote_head || null,
    warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
    followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
    followup_findings: Array.isArray(taskResult.followup_findings) ? taskResult.followup_findings : [],
    followup_processing: taskResult.followup_processing || null,
    quality_notes: Array.isArray(taskResult.quality_notes) ? taskResult.quality_notes : [],
    verification: taskResult.verification || null,
    contract_verification: taskResult.contract_verification || taskResult.verification?.contract_verification || taskResult.final_verification?.contract_verification || null,
    final_verification: taskResult.final_verification || null,
    acceptance_gate: taskResult.acceptance_gate || null,
    acceptance_result_path: taskResult.acceptance_result_path || null,
    closure_decision: taskResult.closure_decision || null,
    finalizer_decision: taskResult.finalizer_decision || null,
    unified_decision: taskResult.unified_decision || taskResult.finalizer_decision?.unified_decision || null,
    no_change_repair_completion_summary: taskResult.no_change_repair_completion_summary || null,
    no_change_repair_completion: taskResult.no_change_repair_completion || null,
    failure_class: taskResult.failure_class || null,
    attempt: taskResult.attempt ?? null,
    repair_of_attempt: taskResult.repair_of_attempt ?? null,
    repo_resolution: taskResult.repo_resolution || null,
    worktree_lifecycle: taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null,
    worktree_lifecycle_proof: taskResult.worktree_lifecycle_proof || buildWorktreeLifecycleProof(taskResult),
    execution_cwd: taskResult.execution_cwd || null,
    execution_cwd_proof: taskResult.execution_cwd_proof || buildExecutionCwdProof(taskResult),
    queue_autostart_fix: taskResult.queue_autostart_fix || null,
    evidence_paths: taskResult.evidence_paths || null,
    reviewer_decision: taskResult.reviewer_decision || null,
    auto_integration_completion: taskResult.auto_integration_completion || null,
    acceptance_findings: Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [],
    next_tasks: Array.isArray(taskResult.next_tasks) ? taskResult.next_tasks : [],
    delivery_result_recovery: taskResult.delivery_result_recovery || null,
    integration: taskResult.integration || null,
    needs_integration: taskResult.needs_integration === true,
    needs_restart_check: taskResult.needs_restart_check === true,
    delivery_state_normalized: taskResult.delivery_state_normalized === true,
  };
}

export function normalizeCompletedDeliveryState({ taskStatus, taskResult = {} } = {}) {
  if (taskStatus !== "completed") return taskResult;

  const warnings = Array.isArray(taskResult.warnings)
    ? taskResult.warnings.filter((warning) => !/^Worktree retained:/i.test(String(warning || "")))
    : [];

  if (!hasIntegratedCommitEvidence(taskResult) || !hasRuntimeHeadConvergence(taskResult)) {
    return { ...taskResult, warnings };
  }

  const next = {
    ...taskResult,
    warnings,
    needs_integration: false,
    needs_restart_check: false,
    delivery_state_normalized: true,
  };
  if (next.closure_path === "integrate") next.closure_path = "complete";
  if (typeof next.closure_summary === "string") {
    next.closure_summary = next.closure_summary
      .replace(/Closure path: integrate/g, "Closure path: complete")
      .replace(/Code change task \([^)]*\)\. Needs integration\./g, "Completed code change task is integrated and runtime-verified.")
      .replace(/Restart check: required/g, "Restart check: not required");
  }
  return next;
}

export function hasIntegratedCommitEvidence(taskResult = {}) {
  const integration = taskResult.integration || {};
  if (integration.merged === true) return true;
  if (integration.satisfied === true) return true;
  if (["merged", "skipped", "already_integrated", "not_required"].includes(integration.status)) return true;
  if (taskResult.auto_integration_completion?.completed === true) return true;
  if (taskResult.delivery_result_recovery?.commit_integrated === true) return true;
  return false;
}

export function hasRuntimeHeadConvergence(taskResult = {}) {
  const autoCompletion = taskResult.auto_integration_completion || null;
  const commit = taskResult.commit || autoCompletion?.commit || taskResult.delivery_result_recovery?.commit || null;
  const localHead = taskResult.local_head || autoCompletion?.commit || taskResult.delivery_result_recovery?.local_head || taskResult.repo_head || null;
  const runningCommit = taskResult.running_commit || taskResult.runtime?.running_commit || null;
  const repoHead = taskResult.repo_head || taskResult.runtime?.repo_head || localHead;
  const remoteHead = taskResult.remote_head || taskResult.delivery_result_recovery?.remote_head || null;
  const restartVerified = taskResult.restart_state === "verified" || taskResult.post_restart_verified === true || Boolean(taskResult.restart_verified_at);

  if (!commit || !localHead) return false;
  if (commit !== localHead) return false;
  if (repoHead && repoHead !== commit) return false;
  if (remoteHead && remoteHead !== commit) return false;
  if (runningCommit && runningCommit !== commit) return false;
  return restartVerified || !runningCommit;
}

export function buildWorktreeLifecycleProof(taskResult = {}) {
  const lifecycle = taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null;
  if (!lifecycle) return null;
  return {
    mode: lifecycle.mode || null,
    ok: lifecycle.ok === true,
    git_worktree_created: lifecycle.git_worktree_created === true,
    existing: lifecycle.existing === true,
    cleanup_supported: lifecycle.cleanup_supported === true,
    cleanup_ok: lifecycle.cleanup ? lifecycle.cleanup.ok === true : null,
    task_worktree_path: taskResult.repo_resolution?.task_worktree_path || lifecycle.worktree_path || null,
    created_during_run: lifecycle.created_during_run === true || lifecycle.git_worktree_created === true,
  };
}

export function buildExecutionCwdProof(taskResult = {}) {
  const cwd = taskResult.execution_cwd || taskResult.execution_cwd_proof?.cwd || null;
  const taskWorktreePath = taskResult.repo_resolution?.task_worktree_path || taskResult.execution_cwd_proof?.task_worktree_path || null;
  const canonicalRepoPath = taskResult.repo_resolution?.canonical_repo_path || taskResult.execution_cwd_proof?.canonical_repo_path || null;
  if (!cwd && !taskWorktreePath && !canonicalRepoPath) return null;
  return {
    cwd,
    task_worktree_path: taskWorktreePath,
    canonical_repo_path: canonicalRepoPath,
    used_task_worktree_path: Boolean(cwd && taskWorktreePath && cwd === taskWorktreePath),
  };
}

export function applyVerifiedDeliveryResultRecovery({ taskStatus, taskResult = {}, summary = "", deliveryResultRecovery = null }) {
  const recovery = deliveryResultRecovery || taskResult.delivery_result_recovery || null;
  if (!recovery) return { taskStatus, taskResult, summary };

  const verification = recovery.verification || taskResult.verification || null;
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  const verified = verification?.passed === true && commands.length > 0;
  const canonicalClean = recovery.canonical_clean === true;
  const commitIntegrated = recovery.commit_integrated === true;
  const hasHeads = Boolean(recovery.commit && recovery.local_head && recovery.remote_head);

  const nextTaskResult = {
    ...taskResult,
    delivery_result_recovery: {
      ...recovery,
      verification,
      passed: verified && canonicalClean && commitIntegrated && hasHeads,
    },
  };

  if (!(verified && canonicalClean && commitIntegrated && hasHeads)) {
    return { taskStatus, taskResult: nextTaskResult, summary };
  }

  const findings = Array.isArray(nextTaskResult.acceptance_findings) ? [...nextTaskResult.acceptance_findings] : [];
  findings.push({
    severity: "followup",
    code: "result_missing_but_verified_commit",
    message: "Codex CLI/result writeback failed, but canonical commit integration and verification evidence are complete.",
    source: "task_final_writeback",
    resolved: true,
  });

  const recoveredSummary = recovery.summary || summary || nextTaskResult.summary || "Delivery result writeback recovered from verified commit evidence.";
  return {
    taskStatus: "completed",
    summary: recoveredSummary,
    taskResult: {
      ...nextTaskResult,
      kind: "codex_executed",
      summary: recoveredSummary,
      failure_class: "delivery_result_writeback_missing",
      changed_files: Array.isArray(recovery.changed_files) ? recovery.changed_files : (Array.isArray(nextTaskResult.changed_files) ? nextTaskResult.changed_files : []),
      tests: recovery.tests || nextTaskResult.tests || "verified fallback result; see verification.commands",
      commit: recovery.commit,
      local_head: recovery.local_head,
      remote_head: recovery.remote_head,
      verification,
      reviewer_decision: nextTaskResult.reviewer_decision || { status: "accepted", passed: true },
      acceptance_findings: findings,
      followups: Array.isArray(nextTaskResult.followups) ? nextTaskResult.followups : [],
      warnings: Array.isArray(nextTaskResult.warnings) ? nextTaskResult.warnings : [],
      convergence: {
        ...(nextTaskResult.convergence || {}),
        nextStatus: "completed",
        closureReason: "result_missing_but_verified_commit",
      },
    },
  };
}
