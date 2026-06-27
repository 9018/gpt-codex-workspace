import { applyLegacyResolution, findLegacySuccessor, hasCompletionEvidence as hasLegacyCompletionEvidence } from "./legacy-reconciliation.mjs";

const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "timed_out", "blocked", "cancelled"]);
const SYNC_LIKE_PROFILES = new Set([
  "sync_only",
  "github_sync_only",
  "verification_only",
  "noop",
  "repair_noop",
  "network_retry",
]);

export function determineGoalStatus(goal, task, taskResult = {}) {
  if (!goal || !task) return null;
  if (TERMINAL_GOAL_STATUSES.has(goal.status)) return null;

  if (task.status === "completed") {
    return completedGoalStatus(task, taskResult);
  }

  if (task.status === "failed" || task.status === "timed_out" || task.status === "blocked") {
    return failedGoalStatus(task, taskResult);
  }

  if (task.status === "waiting_for_repair") return "waiting_for_repair";
  if (task.status === "waiting_for_integration") return "waiting_for_integration";
  if (task.status === "waiting_for_review") {
    const blockers = genuineBlockers(taskResult);
    if (taskResult?.convergence?.nextStatus === "completed" && blockers.length === 0 && hasCompletionEvidence(taskResult)) {
      return "completed";
    }
    return null;
  }

  return null;
}

function completedGoalStatus(task, taskResult) {
  const blockers = genuineBlockers(taskResult);
  if (blockers.length > 0) return hasRepairableBlocker(blockers) ? "waiting_for_repair" : "waiting_for_review";

  if (taskResult?.convergence?.nextStatus === "completed" && hasCompletionEvidence(taskResult)) {
    return "completed";
  }

  if (hasCompletionEvidence(taskResult)) return "completed";

  const profile = taskResult?.convergence?.profile || taskResult?.acceptance_profile || inferProfile(task, taskResult);
  if (SYNC_LIKE_PROFILES.has(profile) && nonBlockingFindingsOnly(taskResult, profile)) {
    return "completed";
  }

  return "waiting_for_review";
}

function failedGoalStatus(task, taskResult) {
  const repairAttempt = Number(task.repair_attempt ?? taskResult.repair_attempt ?? 0);
  const maxAttempts = Number(task.max_attempts ?? taskResult.repair_plan?.maxAttempts ?? 2);
  const exhausted = task.status === "blocked"
    || taskResult.repair_plan?.exhausted === true
    || taskResult.convergence?.closureReason === "repair_exhausted"
    || repairAttempt >= maxAttempts;
  if (exhausted) return task.status === "blocked" ? "blocked" : "failed";
  if (taskResult.repairable === false || taskResult.failure_class === "result_missing") return "failed";
  return "waiting_for_repair";
}

function hasCompletionEvidence(taskResult = {}) {
  return hasLegacyCompletionEvidence(taskResult);
}

function genuineBlockers(taskResult = {}) {
  const profile = taskResult?.convergence?.profile || taskResult?.acceptance_profile || "code_change";
  const findings = Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [];
  return findings.filter((finding) => {
    if (!finding || finding.resolved === true) return false;
    if (finding.severity !== "blocker" && finding.severity !== "major") return false;
    return !isNonBlockerForProfile(finding.code, profile);
  });
}

function nonBlockingFindingsOnly(taskResult = {}, profile) {
  const findings = Array.isArray(taskResult.acceptance_findings) ? taskResult.acceptance_findings : [];
  return findings.every((finding) => {
    if (!finding || finding.resolved === true) return true;
    if (finding.severity !== "blocker" && finding.severity !== "major") return true;
    return isNonBlockerForProfile(finding.code, profile);
  });
}

function hasRepairableBlocker(blockers) {
  return blockers.some((finding) => !String(finding.code || "").startsWith("integration_branch_pushed"));
}

function inferProfile(task = {}, taskResult = {}) {
  if (task.mode === "sync") return "sync_only";
  if (task.mode === "github_sync") return "github_sync_only";
  if (task.mode === "verification") return "verification_only";
  if (task.mode === "noop" || taskResult.noop === true) return "noop";
  if (task.parent_task_id || task.repair_of_task_id) {
    const files = Array.isArray(taskResult.changed_files) ? taskResult.changed_files : [];
    return files.length > 0 ? "repair_code_change" : "repair_noop";
  }
  return "code_change";
}

function isNonBlockerForProfile(code, profile) {
  if (!code || !profile) return false;
  if (code === "tests_missing") return SYNC_LIKE_PROFILES.has(profile);
  if (code === "changed_files_mismatch") return SYNC_LIKE_PROFILES.has(profile);
  if (code === "git_worktree_lifecycle_metadata_only") return true;
  if (code === "worktree_no_changes_yet") return true;
  return false;
}

export async function convergeStaleGoalStatuses(store) {
  const state = await store.load();
  const changes = [];
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];

  for (const goal of goals) {
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) continue;
    const linkedTask = tasks.find((task) => task.id === goal.task_id);
    if (!linkedTask) continue;
    const legacySuccessor = findLegacySuccessor({ legacyTask: linkedTask, legacyGoal: goal, tasks, goals });
    if (legacySuccessor) {
      const previousStatus = goal.status;
      const updatedAt = new Date().toISOString();
      const changed = applyLegacyResolution({
        goal,
        task: linkedTask,
        successor: legacySuccessor.task,
        evidence: legacySuccessor.evidence,
        timestamp: updatedAt,
      });
      if (changed) {
        state.activities ||= [];
        state.activities.push({
          time: updatedAt,
          type: "goal.completed",
          goal_id: goal.id,
          title: goal.title,
          reason: `legacy goal converged from ${previousStatus} via successor task ${legacySuccessor.task.id}`,
        });
        changes.push({
          goal_id: goal.id,
          from: previousStatus,
          to: "completed",
          reason: `superseded_by=${legacySuccessor.task.id} commit=${legacySuccessor.evidence.commit || "none"}`,
        });
      }
      continue;
    }
    if (!TERMINAL_TASK_STATUSES.has(linkedTask.status) && !String(linkedTask.status || "").startsWith("waiting_for_")) continue;

    const nextStatus = determineGoalStatus(goal, linkedTask, linkedTask.result || {});
    if (!nextStatus || nextStatus === goal.status) continue;

    const previousStatus = goal.status;
    const updatedAt = new Date().toISOString();
    goal.status = nextStatus;
    goal.updated_at = updatedAt;
    state.activities ||= [];
    state.activities.push({
      time: updatedAt,
      type: `goal.${nextStatus}`,
      goal_id: goal.id,
      title: goal.title,
      reason: `converged from ${previousStatus} via task ${linkedTask.id}`,
    });
    changes.push({
      goal_id: goal.id,
      from: previousStatus,
      to: nextStatus,
      reason: `task=${linkedTask.id} status=${linkedTask.status}`,
    });
  }

  if (changes.length > 0 && typeof store.save === "function") await store.save();
  return changes;
}
