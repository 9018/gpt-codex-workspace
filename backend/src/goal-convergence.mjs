import { REVIEW_STATES, createReviewStateBlock } from './task-review-status-taxonomy.mjs';

import { applyLegacyResolution, findLegacySuccessor, hasCompletionEvidence as hasLegacyCompletionEvidence } from "./legacy-reconciliation.mjs";
import { UNIFIED_STATUSES } from './codex-unified-decision.mjs';
import {
  TASK_STATUSES,
  isHumanReviewStatus,
  isNonTerminalWaitStatus,
  isTerminalStatus,
  normalizeTaskStatus,
} from "./task-status-taxonomy.mjs";

const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const SYNC_LIKE_PROFILES = new Set([
  "sync_only",
  "github_sync_only",
  "verification_only",
  "noop",
  "repair_noop",
  "network_retry",
]);

export function determineGoalStatus(goal, task, taskResult = {}) {


  // P0-AFC4: Use unified_decision as the SINGLE source of truth — trust the
  // canonical outcome unconditionally when status is completed. Older evidence
  // fields (acceptance_findings, verification, integration) cannot override it.
  if (taskResult && taskResult.unified_decision && taskResult.unified_decision.status) {
    const ud = taskResult.unified_decision;
    if (ud.status === UNIFIED_STATUSES.COMPLETED) {
      return 'completed';
    }
    if (ud.status === UNIFIED_STATUSES.FAILED || ud.status === UNIFIED_STATUSES.BLOCKED || ud.status === UNIFIED_STATUSES.TIMED_OUT) {
      return ud.status;
    }
    if (ud.status === UNIFIED_STATUSES.WAITING_FOR_REPAIR) return 'waiting_for_repair';
    if (ud.status === UNIFIED_STATUSES.WAITING_FOR_INTEGRATION) return 'waiting_for_integration';
    if (ud.requires_review || ud.status === UNIFIED_STATUSES.WAITING_FOR_REVIEW || ud.status === UNIFIED_STATUSES.WAITING_FOR_HUMAN_REVIEW) {
      return REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW;
    }
    // Fall through for non-terminal hold statuses
    return null;
  }
  if (!goal || !task) return null;
  if (TERMINAL_GOAL_STATUSES.has(goal.status)) return null;

  const taskStatus = normalizeTaskStatus(task.status);

  if (taskStatus === TASK_STATUSES.COMPLETED) {
    return completedGoalStatus(task, taskResult);
  }

  if (
    taskStatus === TASK_STATUSES.FAILED
    || taskStatus === TASK_STATUSES.TIMED_OUT
    || taskStatus === TASK_STATUSES.BLOCKED
  ) {
    return failedGoalStatus(task, taskResult);
  }

  if (taskStatus === TASK_STATUSES.WAITING_FOR_REPAIR) return "waiting_for_repair";
  if (taskStatus === TASK_STATUSES.WAITING_FOR_INTEGRATION) return "waiting_for_integration";
  if (isHumanReviewStatus(taskStatus)) {
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
  if (blockers.length > 0) return hasRepairableBlocker(blockers) ? "waiting_for_repair" : REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW;

  if (taskResult?.convergence?.nextStatus === "completed" && hasCompletionEvidence(taskResult)) {
    return "completed";
  }

  if (hasCompletionEvidence(taskResult)) return "completed";

  const profile = taskResult?.convergence?.profile || taskResult?.acceptance_profile || inferProfile(task, taskResult);
  if (SYNC_LIKE_PROFILES.has(profile) && nonBlockingFindingsOnly(taskResult, profile)) {
    return "completed";
  }

  return REVIEW_STATES.WAITING_FOR_HUMAN_REVIEW;
}

function failedGoalStatus(task, taskResult) {
  const taskStatus = normalizeTaskStatus(task.status);
  const repairAttempt = Number(task.repair_attempt ?? taskResult.repair_attempt ?? 0);
  const maxAttempts = Number(task.max_attempts ?? taskResult.repair_plan?.maxAttempts ?? 2);
  const exhausted = taskStatus === TASK_STATUSES.BLOCKED
    || taskResult.repair_plan?.exhausted === true
    || taskResult.convergence?.closureReason === "repair_exhausted"
    || repairAttempt >= maxAttempts;
  if (exhausted) return taskStatus === TASK_STATUSES.BLOCKED ? "blocked" : "failed";
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
    if (!isTerminalStatus(linkedTask.status) && !isNonTerminalWaitStatus(linkedTask.status)) continue;

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
