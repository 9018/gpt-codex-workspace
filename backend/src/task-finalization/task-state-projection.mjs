export function applyTaskStateProjection(item, { taskStatus, taskResult = {}, doneAt, cr = {}, config = {} } = {}) {
  const canonicalStatus = taskStatus
    || taskResult?.finalizer_decision?.status
    || taskResult?.unified_decision?.status;
  item.status = canonicalStatus;
  item.execution_mode = deriveExecutionMode(taskResult, item);
  item.worktree = deriveSpecWorktreeRecord(taskResult, item.worktree);
  item.attempt = Number.isInteger(item.attempt) ? item.attempt : 0;
  item.max_attempts = Number.isInteger(item.max_attempts) ? item.max_attempts : 2;
  item.result = { ...taskResult, completed_at: doneAt };
  item.logs.push({ time: doneAt, message: taskResult.kind === "no_first_output_timeout"
    ? "[worker] timed out waiting for first Codex output after " + (cr?.first_output_timeout_seconds || config.codexFirstOutputTimeout || 180) + "s"
    : taskResult.kind === "codex_timeout"
      ? "[worker] timed out after " + config.codexExecTimeout + "s"
      : "[worker] completed: task processed by Codex CLI" });
  if (taskResult.delivery_result_recovery?.attempted === true) {
    const recovery = taskResult.delivery_result_recovery;
    item.logs.push({
      time: doneAt,
      message: recovery.recovered === true
        ? `[worker] delivery recovery attempted: eligible=${recovery.eligible === true} recovered=true commit=${recovery.commit || "none"}`
        : `[worker] delivery recovery failed: ${recovery.reason || recovery.blockers?.[0]?.code || "unknown"}`,
    });
  }
  if (taskResult.auto_integration_completion?.attempted === true) {
    const autoCompletion = taskResult.auto_integration_completion;
    item.logs.push({
      time: doneAt,
      message: autoCompletion.completed === true
        ? `[worker] auto integration completion: ff-only merged and verified commit=${autoCompletion.commit || "none"} report=${autoCompletion.verification_report_path || "none"}`
        : `[worker] auto integration completion failed: ${autoCompletion.reason || autoCompletion.blockers?.[0]?.code || "unknown"}`,
    });
  }
  if (taskResult.failure_class || taskResult.repair_attempt !== undefined || taskResult.repair_of_attempt !== undefined) {
    item.logs.push({
      time: doneAt,
      message: `[worker] failure_class=${taskResult.failure_class || "none"} attempt=${item.attempt} repair_of_attempt=${taskResult.repair_of_attempt ?? "none"}`,
    });
  }
}

export function deriveExecutionMode(taskResult = {}, existingTask = {}) {
  if (taskResult.repo_resolution?.worktree_lifecycle?.mode === "git_worktree" || taskResult.worktree_lifecycle?.mode === "git_worktree") {
    return "worktree";
  }
  return existingTask.execution_mode || "canonical";
}

export function deriveSpecWorktreeRecord(taskResult = {}, existingWorktree = null) {
  const lifecycle = taskResult.worktree_lifecycle || taskResult.repo_resolution?.worktree_lifecycle || null;
  const path = taskResult.repo_resolution?.task_worktree_path || lifecycle?.worktree_path || existingWorktree?.path || null;
  if (!lifecycle && !path && !existingWorktree) return undefined;
  const cleanupStatus = lifecycle?.cleanup
    ? lifecycle.cleanup.ok === true ? "removed" : "cleanup_failed"
    : null;
  const status = cleanupStatus
    || lifecycle?.status
    || (lifecycle?.ok === true ? (taskResult.status === "running" ? "running" : "completed") : "cleanup_failed");
  return {
    enabled: lifecycle?.mode === "git_worktree" || existingWorktree?.enabled === true,
    path,
    branch: lifecycle?.branch_name || existingWorktree?.branch || null,
    base_ref: lifecycle?.base_ref || existingWorktree?.base_ref || null,
    base_sha: lifecycle?.base_sha || existingWorktree?.base_sha || null,
    head_sha: lifecycle?.head_sha || existingWorktree?.head_sha || null,
    status,
  };
}
