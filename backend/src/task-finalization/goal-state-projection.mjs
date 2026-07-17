import { determineGoalStatus } from "../goal-convergence.mjs";

export function projectGoalStatusForFinalizedTask({ goal = null, task = {}, taskStatus, taskResult = {}, state = {} } = {}) {
  if (!goal) return null;
  const canonicalStatus = taskStatus
    || taskResult?.finalizer_decision?.status
    || taskResult?.unified_decision?.status;
  let goalStatus = determineGoalStatus(goal, task, task.result || taskResult || {})
    || (canonicalStatus === "timed_out" ? "failed" : canonicalStatus);
  const hasRunningQueueItem = Array.isArray(state.goal_queue)
    && state.goal_queue.some((candidate) => candidate.task_id === task.id && candidate.status === "running");
  if ((taskStatus === "failed" || taskStatus === "timed_out") && goalStatus === "failed" && hasRunningQueueItem) {
    goalStatus = "waiting_for_repair";
  }
  if (goalStatus === "waiting_for_human_review") goalStatus = "waiting_for_review";
  return goalStatus;
}

export function applyGoalStateProjection(goalItem, { task = {}, taskStatus, taskResult = {}, state = {}, doneAt } = {}) {
  const goalStatus = projectGoalStatusForFinalizedTask({
    goal: goalItem,
    task,
    taskStatus,
    taskResult,
    state,
  });
  if (!goalStatus) return null;
  goalItem.status = goalStatus;
  goalItem.updated_at = doneAt;
  return goalStatus;
}
