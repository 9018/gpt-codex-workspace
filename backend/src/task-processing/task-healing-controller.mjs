export const RETRY_HEALING_ACTIONS = new Set([
  "retry_with_backoff",
  "cleanup_and_retry",
  "compact_and_retry",
  "reconcile_lock_and_retry",
  "recover_and_retry",
  "fallback_parse_and_retry",
]);

export function statusForHealingAction(action) {
  return RETRY_HEALING_ACTIONS.has(action) ? "queued" : "waiting_for_review";
}

export async function parkTaskForHealingRetry({ store, config, task, goal, context, updateTaskFn, appendGoalMessageFn, releaseLockForTaskFn, repoLockPath, error, healingAction, prefix }) {
  const status = statusForHealingAction(healingAction.action);
  const retryCount = RETRY_HEALING_ACTIONS.has(healingAction.action) ? (task.healing_retry_count || 0) + 1 : (task.healing_retry_count || 0);
  const summary = `${prefix}: ${error?.message || String(error || "unknown error")}`;
  if (repoLockPath) {
    try { await releaseLockForTaskFn(config.defaultWorkspaceRoot, task.id); } catch {}
  }
  await updateTaskFn(store, task.id, (item) => {
    item.status = status;
    if (RETRY_HEALING_ACTIONS.has(healingAction.action)) item.healing_retry_count = retryCount;
    item.result = {
      kind: "operational_error",
      summary,
      completed_at: new Date().toISOString(),
      error_code: error?.code || null,
      healing_action: healingAction.action,
      healing_retry_count: retryCount,
      retry_budget: healingAction.retry_budget ?? null,
      reason: healingAction.reason || summary,
    };
    item.logs.push({ time: new Date().toISOString(), message: summary });
    item.logs.push({ time: new Date().toISOString(), message: `[worker] self-healing ${healingAction.action}: status=${status} retry=${retryCount} reason=${healingAction.reason || "none"}` });
  });
  if (goal) {
    try {
      await appendGoalMessageFn(store, config, {
        goal_id: goal.id,
        role: "codex",
        content: summary + " (healing: " + healingAction.action + ")",
      }, context);
    } catch {}
  }
  return { task_id: task.id, status, kind: "operational_error", reason: summary, healing_action: healingAction.action, healing_retry_count: retryCount };
}
