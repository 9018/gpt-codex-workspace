/**
import { classifyCanonicalDirty } from "./canonical-recovery.mjs";
 * runtime-patrol-loop.mjs — AFC-10 Runtime Patrol / Self-Healing Loop
 *
 * Patrols all AFC task states and detects:
 *   1. Stalled tasks — tasks stuck in any non-terminal state beyond a threshold
 *   2. Misclassified tasks — graph_node / status incongruence
 *   3. waiting_for_review/repair/integration blockers — tasks orphaned in hold states
 *   4. Missing evidence — tasks lacking required result evidence
 *   5. Dirty canonical repo blockers — canonical repo unrecoverably dirty
 *   6. Missing AFC tasks — goal/queue references to non-existent tasks
 *
 * Produces SAFE patrol actions. Never auto-merges. All findings are
 * diagnostic-only by default (dryRun=true).
 *
 * Safety invariants:
 *   - NEVER produces an action with safety !== "safe" without flagging needs_review
 *   - NEVER auto-merges, auto-pushes, or auto-integrates
 *   - NEVER overwrites user/operator review decisions
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  TASK_STATUSES,
  isTerminalStatus,
  isActiveExecutionStatus,
  isHumanReviewStatus,
  isRepairStatus,
  isTypedReviewStatus,
  isMachineRepairableReviewStatus,
} from "./task-status-taxonomy.mjs";
import {
  GRAPH_NODES,
  isValidGraphNode,
} from "./task-graph-state.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default stall threshold: 30 minutes for most states.
 * Longer than the lock threshold (15 min) since patrol covers non-lock states.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 1_800_000; // 30 minutes

/**
 * Extended threshold for states that naturally wait longer
 * (review, human_interrupted).
 */
export const EXTENDED_STALL_THRESHOLD_MS = 7_200_000; // 2 hours

/**
 * Patrol diagnostic levels.
 */
const LEVEL = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  BLOCKER: "blocker",
  CRITICAL: "critical",
});

/**
 * Safety classifications for patrol actions.
 */
const SAFETY = Object.freeze({
  SAFE: "safe",
  NEEDS_REVIEW: "needs_review",
  BLOCKED: "blocked",
});

/**
 * Patrol category labels.
 */
const CAT = Object.freeze({
  STALLED_TASK: "stalled_task",
  MISCLASSIFIED_TASK: "misclassified_task",
  REVIEW_BLOCKER: "review_blocker",
  REPAIR_BLOCKER: "repair_blocker",
  INTEGRATION_BLOCKER: "integration_blocker",
  MISSING_EVIDENCE: "missing_evidence",
  DIRTY_CANONICAL_REPO: "dirty_canonical_repo",
  MISSING_AFC_TASK: "missing_afc_task",
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowISO() {
  return new Date().toISOString();
}

function ageMs(dateStr) {
  if (!dateStr) return 0;
  return Date.now() - new Date(dateStr).getTime();
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// 1. Detect stalled tasks
// ---------------------------------------------------------------------------

/**
 * Detect tasks stuck in a non-terminal, non-active-execution state for
 * longer than the stall threshold.
 *
 * Running tasks are NOT checked here — they are covered by
 * detectTerminalTasksRunning in runtime-watch-diagnostics.mjs.
 *
 * @param {object} state — Full state object with tasks[]
 * @param {object} [options]
 * @param {number} [options.stallThresholdMs=DEFAULT_STALL_THRESHOLD_MS]
 * @param {number} [options.extendedThresholdMs=EXTENDED_STALL_THRESHOLD_MS]
 * @returns {object[]} Patrol findings
 */
export function detectStalledTasks(state, {
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  extendedThresholdMs = EXTENDED_STALL_THRESHOLD_MS,
} = {}) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;
    if (isTerminalStatus(task.status)) continue;
    if (task.status === "running") continue;

    const status = (task.status || "").toLowerCase();
    const updatedAt = task.updated_at || task.created_at;
    if (!updatedAt) continue;

    const age = ageMs(updatedAt);
    const isExtendedStatus =
      status === TASK_STATUSES.WAITING_FOR_REVIEW ||
      status === TASK_STATUSES.HUMAN_INTERRUPTED ||
      status === "human_interrupted" ||
      status === "human_interrupted_for_repair_budget_exhausted" ||
      isTypedReviewStatus(status) ||
      isHumanReviewStatus(status);

    const threshold = isExtendedStatus ? extendedThresholdMs : stallThresholdMs;

    if (age < threshold) continue;

    // Determine the state family for reporting
    let stateFamily;
    if (isRepairStatus(status)) {
      stateFamily = "repair";
    } else if (isHumanReviewStatus(status) || isTypedReviewStatus(status)) {
      stateFamily = "review";
    } else if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
      stateFamily = "integration";
    } else if (status === TASK_STATUSES.WAITING_FOR_LOCK) {
      stateFamily = "lock";
    } else if (status === TASK_STATUSES.QUEUED || status === TASK_STATUSES.ASSIGNED) {
      stateFamily = "pending";
    } else {
      stateFamily = "unknown";
    }

    const ageStr = formatDuration(age);

    findings.push({
      category: CAT.STALLED_TASK,
      level: LEVEL.WARNING,
      description: `Task ${task.id} stalled in "${status}" for ${ageStr} (threshold ${formatDuration(threshold)})`,
      task_id: task.id,
      goal_id: task.goal_id || "",
      detail: {
        status,
        state_family: stateFamily,
        age_ms: age,
        threshold_ms: threshold,
        updated_at: updatedAt,
        graph_node: task.graph_node || null,
      },
      recommended_action: synthesizeStallAction(task, status, stateFamily),
    });
  }

  return findings;
}

/**
 * Determine the recommended action for a stalled task based on its state.
 */
function synthesizeStallAction(task, status, stateFamily) {
  switch (stateFamily) {
    case "repair": {
      const maxAttempts = task.max_attempts || task.maxAttempts || 2;
      const attempt = task.repair_attempt || task.attempt || 0;
      const exhausted = attempt >= maxAttempts;
      if (exhausted) {
        return {
          action: "flag_for_review",
          safety: SAFETY.NEEDS_REVIEW,
          description: `Repair budget exhausted (${attempt}/${maxAttempts}). Flag for human terminal decision.`,
          target: { domain: "task", id: task.id },
        };
      }
      return {
        action: "trigger_repair",
        safety: SAFETY.NEEDS_REVIEW,
        description: `Stalled in repair (attempt ${attempt}/${maxAttempts}). Recommend re-triggering repair.`,
        target: { domain: "task", id: task.id },
      };
    }
    case "review": {
      if (isMachineRepairableReviewStatus(status)) {
        return {
          action: "auto_status_update",
          safety: SAFETY.SAFE,
          description: `Stalled in machine-repairable review state "${status}". Recommend auto-repair activation.`,
          target: { domain: "task", id: task.id },
        };
      }
      return {
        action: "flag_for_review",
        safety: SAFETY.NEEDS_REVIEW,
        description: `Stalled in human review state "${status}" for extended period. Flag for human attention.`,
        target: { domain: "task", id: task.id },
      };
    }
    case "integration": {
      return {
        action: "flag_for_review",
        safety: SAFETY.NEEDS_REVIEW,
        description: "Stalled in integration for extended period. Check worktree and canonical repo state.",
        target: { domain: "task", id: task.id },
      };
    }
    case "lock": {
      return {
        action: "flag_for_review",
        safety: SAFETY.SAFE,
        description: "Stalled waiting for lock. Recommend checking lock state via runtime-watch diagnostics.",
        target: { domain: "task", id: task.id },
      };
    }
    case "pending": {
      return {
        action: "flag_for_review",
        safety: SAFETY.SAFE,
        description: "Task queued/assigned for extended period without progress. Flag for reprocessing.",
        target: { domain: "task", id: task.id },
      };
    }
    default: {
      return {
        action: "flag_for_review",
        safety: SAFETY.NEEDS_REVIEW,
        description: `Task stalled in unknown/unusual state "${status}". Manual investigation recommended.`,
        target: { domain: "task", id: task.id },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Detect misclassified tasks
// ---------------------------------------------------------------------------

/**
 * Detect tasks where the graph_node and status are incongruent.
 *
 * @param {object} state — Full state object with tasks[]
 * @returns {object[]} Patrol findings
 */
export function detectMisclassifiedTasks(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;

    const status = (task.status || "").toLowerCase();
    const graphNode = task.graph_node || null;

    if (!graphNode) continue;
    if (!isValidGraphNode(graphNode)) continue;

    const isTerminal = isTerminalStatus(status);
    const graphNodeIsTerminal =
      graphNode === GRAPH_NODES.CLOSED ||
      graphNode === GRAPH_NODES.FAILED_TERMINAL;

    // Misclassification 1: terminal status + non-terminal graph_node
    if (isTerminal && !graphNodeIsTerminal) {
      findings.push({
        category: CAT.MISCLASSIFIED_TASK,
        level: LEVEL.WARNING,
        description: `Task ${task.id} has status "${status}" (terminal) but graph_node="${graphNode}" (non-terminal). Graph node should be CLOSED or FAILED_TERMINAL.`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          status,
          graph_node: graphNode,
          mismatch: "terminal_status_non_terminal_graph_node",
          expected_graph_node: status === "completed" ? GRAPH_NODES.CLOSED : GRAPH_NODES.FAILED_TERMINAL,
        },
        recommended_action: {
          action: "auto_status_update",
          safety: SAFETY.SAFE,
          description: `Graph node "${graphNode}" should be advanced to "${status === "completed" ? GRAPH_NODES.CLOSED : GRAPH_NODES.FAILED_TERMINAL}" to match terminal status.`,
          target: { domain: "task", id: task.id },
        },
      });
      continue;
    }

    // Misclassification 2: non-terminal status + terminal graph_node
    if (!isTerminal && graphNodeIsTerminal) {
      findings.push({
        category: CAT.MISCLASSIFIED_TASK,
        level: LEVEL.BLOCKER,
        description: `Task ${task.id} has status "${status}" (non-terminal) but graph_node="${graphNode}" (terminal). Status or graph node is inconsistent.`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          status,
          graph_node: graphNode,
          mismatch: "non_terminal_status_terminal_graph_node",
        },
        recommended_action: {
          action: "flag_for_review",
          safety: SAFETY.NEEDS_REVIEW,
          description: `Inconsistent state: status="${status}" but graph_node="${graphNode}". Manual review needed to determine which is correct.`,
          target: { domain: "task", id: task.id },
        },
      });
      continue;
    }

    // Misclassification 3: "running" status but graph_node is CREATED
    if (status === "running" && graphNode === GRAPH_NODES.CREATED) {
      findings.push({
        category: CAT.MISCLASSIFIED_TASK,
        level: LEVEL.WARNING,
        description: `Task ${task.id} is "running" but graph_node="${GRAPH_NODES.CREATED}" — graph node not advanced for an active task.`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          status,
          graph_node: graphNode,
          mismatch: "running_but_created",
        },
        recommended_action: {
          action: "auto_status_update",
          safety: SAFETY.SAFE,
          description: `Set graph_node to "${GRAPH_NODES.BUILDER_RUNNING}" to match running status.`,
          target: { domain: "task", id: task.id },
        },
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 3. Detect review/repair/integration blockers
// ---------------------------------------------------------------------------

/**
 * Detect tasks stuck in review/repair/integration states with specific
 * blocking conditions that should have been auto-resolved.
 *
 * @param {object} state — Full state object with tasks[]
 * @returns {object[]} Patrol findings
 */
export function detectReviewRepairIntegrationBlockers(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;

    const status = (task.status || "").toLowerCase();
    const taskResult = task.result || {};

    // ── Review blockers ──────────────────────────────────────────────
    if (status === TASK_STATUSES.WAITING_FOR_REVIEW || isTypedReviewStatus(status)) {
      const blockers = Array.isArray(task.blockers) ? task.blockers : [];
      const hasActiveBlocker = blockers.some(b => b && !b.resolved_at);

      if (!hasActiveBlocker) {
        findings.push({
          category: CAT.REVIEW_BLOCKER,
          level: LEVEL.WARNING,
          description: `Task ${task.id} in "${status}" state but no active blockers found.`,
          task_id: task.id,
          goal_id: task.goal_id || "",
          detail: {
            status,
            blockers,
            has_active_blocker: hasActiveBlocker,
          },
          recommended_action: {
            action: "flag_for_review",
            safety: SAFETY.SAFE,
            description: `No active blockers for "${status}" state. Flag for status reassessment.`,
            target: { domain: "task", id: task.id },
          },
        });
        continue;
      }

      const allMachineResolvable = blockers
        .filter(b => b && !b.resolved_at)
        .every(b => b.machine_resolvable === true || b.safety === "safe");

      if (allMachineResolvable && isMachineRepairableReviewStatus(status)) {
        findings.push({
          category: CAT.REVIEW_BLOCKER,
          level: LEVEL.INFO,
          description: `Task ${task.id} in machine-repairable review state "${status}" with ${blockers.filter(b => b && !b.resolved_at).length} machine-resolvable blocker(s).`,
          task_id: task.id,
          goal_id: task.goal_id || "",
          detail: {
            status,
            blockers_count: blockers.length,
            unresolved_count: blockers.filter(b => b && !b.resolved_at).length,
            all_machine_resolvable: true,
          },
          recommended_action: {
            action: "auto_status_update",
            safety: SAFETY.SAFE,
            description: `All blockers in "${status}" are machine-resolvable. Recommend auto-resolution or repair activation.`,
            target: { domain: "task", id: task.id },
          },
        });
      }
    }

    // ── Repair blockers ──────────────────────────────────────────────
    if (status === TASK_STATUSES.WAITING_FOR_REPAIR || status === "waiting_for_repair") {
      const maxAttempts = task.max_attempts || task.maxAttempts || 2;
      const attempt = task.repair_attempt || task.attempt || 0;
      const repairBudget = taskResult.repair_attempts || 0;

      if (attempt >= maxAttempts || repairBudget >= maxAttempts) {
        findings.push({
          category: CAT.REPAIR_BLOCKER,
          level: LEVEL.BLOCKER,
          description: `Task ${task.id} repair budget exhausted (${Math.max(attempt, repairBudget)}/${maxAttempts}).`,
          task_id: task.id,
          goal_id: task.goal_id || "",
          detail: {
            status,
            repair_attempt: attempt,
            repair_budget_used: repairBudget,
            max_attempts: maxAttempts,
            budget_exhausted: true,
          },
          recommended_action: {
            action: "flag_for_review",
            safety: SAFETY.NEEDS_REVIEW,
            description: `Repair budget exhausted (${Math.max(attempt, repairBudget)}/${maxAttempts}). Human terminal decision required.`,
            target: { domain: "task", id: task.id },
          },
        });
      }
    }

    // ── Integration blockers ────────────────────────────────────────
    if (status === TASK_STATUSES.WAITING_FOR_INTEGRATION) {
      const hasWorktree = Boolean(
        task.worktree?.path ||
        task.worktree_path ||
        taskResult.worktree_lifecycle?.worktree_path ||
        taskResult.repo_resolution?.task_worktree_path
      );

      if (!hasWorktree) {
        findings.push({
          category: CAT.INTEGRATION_BLOCKER,
          level: LEVEL.WARNING,
          description: `Task ${task.id} in "waiting_for_integration" but no worktree reference found.`,
          task_id: task.id,
          goal_id: task.goal_id || "",
          detail: {
            status,
            has_worktree: false,
          },
          recommended_action: {
            action: "flag_for_review",
            safety: SAFETY.NEEDS_REVIEW,
            description: "No worktree for integration task. Manual intervention needed to determine integration path.",
            target: { domain: "task", id: task.id },
          },
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 4. Detect missing evidence
// ---------------------------------------------------------------------------

/**
 * Detect tasks missing required result evidence.
 *
 * @param {object} state — Full state object with tasks[]
 * @param {object} [options]
 * @param {boolean} [options.checkDiskPaths=false] — Whether to verify evidence files exist on disk
 * @param {string} [options.workspaceRoot] — Required if checkDiskPaths is true
 * @returns {Promise<object[]>}
 */
export async function detectMissingEvidence(state, options = {}) {
  const { checkDiskPaths = false, workspaceRoot } = options;
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;

    const status = (task.status || "").toLowerCase();
    const taskResult = task.result || {};

    const evidenceFindings = [];

    if (status === TASK_STATUSES.COMPLETED) {
      if (!taskResult.commit && !taskResult.local_head) {
        evidenceFindings.push("result.commit (or local_head)");
      }
      if (!Array.isArray(taskResult.changed_files) || taskResult.changed_files.length === 0) {
        evidenceFindings.push("result.changed_files");
      }
      if (!taskResult.verification && !task.verification) {
        evidenceFindings.push("result.verification");
      }
      if (!taskResult.summary && !task.summary) {
        evidenceFindings.push("result.summary");
      }
    }

    if (isTerminalStatus(status)) {
      if (!taskResult.summary && !taskResult.kind && !task.summary) {
        evidenceFindings.push("result.summary or result.kind");
      }
    }

    if (isHumanReviewStatus(status) || isRepairStatus(status)) {
      if (!taskResult.failure_class && !taskResult.kind && !task.failure_class) {
        evidenceFindings.push("result.failure_class or result.kind");
      }
      if (!taskResult.blockers && !task.blockers) {
        evidenceFindings.push("result.blockers or task.blockers");
      }
    }

    if (checkDiskPaths && workspaceRoot && status === TASK_STATUSES.COMPLETED) {
      const resultPath = join(workspaceRoot, ".gptwork/goals", task.goal_id || "", "result.json");
      const evidencePath = join(workspaceRoot, ".gptwork/goals", task.goal_id || "", "verification.json");

      if (task.goal_id) {
        if (!existsSync(resultPath)) {
          evidenceFindings.push("result.json on disk (not found)");
        }
        if (!existsSync(evidencePath)) {
          evidenceFindings.push("verification.json on disk (not found)");
        }
      }
    }

    if (evidenceFindings.length > 0) {
      findings.push({
        category: CAT.MISSING_EVIDENCE,
        level: evidenceFindings.length >= 3 ? LEVEL.BLOCKER : LEVEL.WARNING,
        description: `Task ${task.id} (${status}) missing ${evidenceFindings.length} required evidence: ${evidenceFindings.join(", ")}`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          status,
          missing_fields: evidenceFindings,
          missing_count: evidenceFindings.length,
        },
        recommended_action: {
          action: "flag_for_review",
          safety: evidenceFindings.length >= 3 ? SAFETY.NEEDS_REVIEW : SAFETY.SAFE,
          description: `Missing ${evidenceFindings.length} evidence field(s). ${evidenceFindings.length >= 3 ? "Review required." : "Flag for evidence collection."}`,
          target: { domain: "task", id: task.id },
        },
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 5. Detect dirty canonical repo blockers
// ---------------------------------------------------------------------------

/**
 * Detect dirty canonical repo and classify the dirtiness.
 * Uses canonical-recovery.mjs for classification.
 *
 * @param {string} canonicalRepoPath — Path to the canonical git repository
 * @returns {object[]} Patrol findings
 */
export function detectDirtyCanonicalRepo(canonicalRepoPath) {
  if (!canonicalRepoPath) return [];


  if (typeof classifyCanonicalDirty !== "function") return [];

  try {
    const classification = classifyCanonicalDirty(canonicalRepoPath);

    if (!classification.is_dirty) return [];

    const isSafe = classification.is_safe_to_clean;

    return [{
      category: CAT.DIRTY_CANONICAL_REPO,
      level: isSafe ? LEVEL.WARNING : LEVEL.BLOCKER,
      description: `Canonical repo is dirty. Classification: "${classification.overall_classification}". ${classification.file_count} file(s) dirty.`,
      task_id: "",
      goal_id: "",
      detail: {
        classification: classification.overall_classification,
        file_count: classification.file_count,
        categories: classification.categories,
        is_safe_to_clean: isSafe,
        status_snapshot: classification.status_snapshot,
      },
      recommended_action: {
        action: "flag_for_review",
        safety: isSafe ? SAFETY.SAFE : SAFETY.NEEDS_REVIEW,
        description: isSafe
          ? `Canonical repo dirty (${classification.overall_classification} — safe to clean). Safe auto-clean available.`
          : `Canonical repo dirty with unexpected source mutations (${classification.overall_classification}). Human review required.`,
        target: { domain: "repo", id: canonicalRepoPath },
      },
    }];
  } catch {
    return [{
      category: CAT.DIRTY_CANONICAL_REPO,
      level: LEVEL.INFO,
      description: `Could not classify canonical repo state at "${canonicalRepoPath}".`,
      task_id: "",
      goal_id: "",
      detail: {
        error: "classification_failed",
        repo_path: canonicalRepoPath,
      },
      recommended_action: {
        action: "flag_for_review",
        safety: SAFETY.SAFE,
        description: "Could not classify canonical repo dirtiness. Manual check recommended.",
        target: { domain: "repo", id: canonicalRepoPath },
      },
    }];
  }
}

// ---------------------------------------------------------------------------
// 6. Detect missing AFC tasks
// ---------------------------------------------------------------------------

/**
 * Detect task references that do not correspond to actual tasks in state.
 *
 * @param {object} state — Full state object with tasks[], goals[], goal_queue[]
 * @returns {object[]} Patrol findings
 */
export function detectMissingAfcTasks(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const queue = Array.isArray(state.goal_queue) ? state.goal_queue : [];
  const registeredTaskIds = new Set(tasks.filter(t => t && t.id).map(t => t.id));

  const findings = [];
  const checked = new Set();

  // Check goals -> task reference
  for (const goal of goals) {
    if (!goal || !goal.id) continue;
    const taskId = goal.task_id || "";
    if (taskId && !registeredTaskIds.has(taskId) && !checked.has(`goal:${goal.id}:${taskId}`)) {
      checked.add(`goal:${goal.id}:${taskId}`);
      findings.push({
        category: CAT.MISSING_AFC_TASK,
        level: LEVEL.WARNING,
        description: `Goal "${goal.id}" references non-existent task "${taskId}".`,
        task_id: taskId,
        goal_id: goal.id,
        detail: {
          reference_type: "goal_to_task",
          goal_id: goal.id,
          missing_task_id: taskId,
          goal_status: goal.status || "(not set)",
        },
        recommended_action: {
          action: "report_missing_task",
          safety: SAFETY.SAFE,
          description: `Goal "${goal.id}" references missing task "${taskId}". Goal progress may be blocked.`,
          target: { domain: "goal", id: goal.id },
        },
      });
    }
  }

  // Check queue items -> task reference
  for (const item of queue) {
    if (!item || !item.queue_id) continue;
    const taskId = item.task_id || "";
    if (taskId && !registeredTaskIds.has(taskId) && !checked.has(`queue:${item.queue_id}:${taskId}`)) {
      checked.add(`queue:${item.queue_id}:${taskId}`);
      findings.push({
        category: CAT.MISSING_AFC_TASK,
        level: LEVEL.WARNING,
        description: `Queue item "${item.queue_id}" references non-existent task "${taskId}".`,
        task_id: taskId,
        goal_id: item.goal_id || "",
        detail: {
          reference_type: "queue_to_task",
          queue_id: item.queue_id,
          missing_task_id: taskId,
          item_status: item.status || "(not set)",
        },
        recommended_action: {
          action: "report_missing_task",
          safety: SAFETY.SAFE,
          description: `Queue item "${item.queue_id}" references missing task "${taskId}". Queue may be blocked.`,
          target: { domain: "queue", id: item.queue_id },
        },
      });
    }
  }

  // Check tasks -> root_task_id / parent_task_id
  for (const task of tasks) {
    if (!task || !task.id) continue;
    const rootTaskId = task.root_task_id || "";
    const parentTaskId = task.parent_task_id || "";

    if (rootTaskId && !registeredTaskIds.has(rootTaskId) && rootTaskId !== task.id && !checked.has(`task:${task.id}:root:${rootTaskId}`)) {
      checked.add(`task:${task.id}:root:${rootTaskId}`);
      findings.push({
        category: CAT.MISSING_AFC_TASK,
        level: LEVEL.INFO,
        description: `Task "${task.id}" references non-existent root_task "${rootTaskId}".`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          reference_type: "task_to_root_task",
          task_id: task.id,
          missing_root_task_id: rootTaskId,
        },
        recommended_action: {
          action: "report_missing_task",
          safety: SAFETY.SAFE,
          description: `Orphan task chain: "${task.id}" references missing root "${rootTaskId}".`,
          target: { domain: "task", id: task.id },
        },
      });
    }

    if (parentTaskId && !registeredTaskIds.has(parentTaskId) && !checked.has(`task:${task.id}:parent:${parentTaskId}`)) {
      checked.add(`task:${task.id}:parent:${parentTaskId}`);
      findings.push({
        category: CAT.MISSING_AFC_TASK,
        level: LEVEL.WARNING,
        description: `Task "${task.id}" references non-existent parent_task "${parentTaskId}".`,
        task_id: task.id,
        goal_id: task.goal_id || "",
        detail: {
          reference_type: "task_to_parent_task",
          task_id: task.id,
          missing_parent_task_id: parentTaskId,
        },
        recommended_action: {
          action: "report_missing_task",
          safety: SAFETY.SAFE,
          description: `Orphan task: "${task.id}" references missing parent "${parentTaskId}".`,
          target: { domain: "task", id: task.id },
        },
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Full patrol loop
// ---------------------------------------------------------------------------

/**
 * Run the full patrol loop. This is the primary entry point.
 *
 * @param {object} options
 * @param {object} options.store — State store
 * @param {string} [options.canonicalRepoPath] — Path to canonical repo for dirty check
 * @param {object} [options.config] — Optional configuration overrides
 * @param {boolean} [options.dryRun=true] — Always true for diagnostic; state changes are explicit
 * @param {number} [options.stallThresholdMs=DEFAULT_STALL_THRESHOLD_MS]
 * @param {number} [options.extendedThresholdMs=EXTENDED_STALL_THRESHOLD_MS]
 * @returns {Promise<object>} Patrol report
 */
export async function runPatrolLoop({
  store,
  canonicalRepoPath,
  config = {},
  dryRun = true,
  stallThresholdMs,
  extendedThresholdMs,
} = {}) {
  const state = await store.load();

  const thresholds = {
    stallThresholdMs: stallThresholdMs || config.stallThresholdMs || DEFAULT_STALL_THRESHOLD_MS,
    extendedThresholdMs: extendedThresholdMs || config.extendedThresholdMs || EXTENDED_STALL_THRESHOLD_MS,
  };

  // Patrol domain 1: stalled tasks
  const stalledTasks = detectStalledTasks(state, thresholds);

  // Patrol domain 2: misclassified tasks
  const misclassifiedTasks = detectMisclassifiedTasks(state);

  // Patrol domain 3: review/repair/integration blockers
  const blockers = detectReviewRepairIntegrationBlockers(state);

  // Patrol domain 4: missing evidence
  const missingEvidence = await detectMissingEvidence(state, {
    checkDiskPaths: config.checkDiskPaths !== false,
    workspaceRoot: config.workspaceRoot,
  });

  // Patrol domain 5: dirty canonical repo
  const dirtyRepo = detectDirtyCanonicalRepo(
    canonicalRepoPath || config.canonicalRepoPath
  );

  // Patrol domain 6: missing AFC tasks
  const missingTasks = detectMissingAfcTasks(state);

  const allFindings = [
    ...stalledTasks,
    ...misclassifiedTasks,
    ...blockers,
    ...missingEvidence,
    ...dirtyRepo,
    ...missingTasks,
  ];

  const recoveryActions = allFindings
    .filter(f => f.recommended_action)
    .map(f => ({
      action: f.recommended_action.action,
      safety: f.recommended_action.safety,
      description: f.recommended_action.description,
      target: f.recommended_action.target,
      category: f.category,
      level: f.level,
      task_id: f.task_id,
      goal_id: f.goal_id,
      is_dry_run: dryRun,
    }));

  const summary = {
    timestamp: nowISO(),
    dry_run: dryRun,
    total_findings: allFindings.length,
    total_recovery_actions: recoveryActions.length,
    categories: {},
    safe_actions: 0,
    needs_review: 0,
    blocked_actions: 0,
  };

  for (const finding of allFindings) {
    const cat = finding.category || "unknown";
    summary.categories[cat] = (summary.categories[cat] || 0) + 1;
  }

  for (const action of recoveryActions) {
    switch (action.safety) {
      case SAFETY.SAFE: summary.safe_actions++; break;
      case SAFETY.NEEDS_REVIEW: summary.needs_review++; break;
      case SAFETY.BLOCKED: summary.blocked_actions++; break;
    }
  }

  return {
    timestamp: nowISO(),
    dry_run: dryRun,
    summary,
    findings: {
      stalled_tasks: stalledTasks,
      misclassified_tasks: misclassifiedTasks,
      blockers,
      missing_evidence: missingEvidence,
      dirty_canonical_repo: dirtyRepo,
      missing_afc_tasks: missingTasks,
    },
    recovery_actions: recoveryActions,
  };
}

// ---------------------------------------------------------------------------
// Format patrol report
// ---------------------------------------------------------------------------

/**
 * Format a patrol loop report as a human-readable string.
 *
 * @param {object} report — Result from runPatrolLoop()
 * @returns {string} Formatted report
 */
export function formatPatrolReport(report) {
  if (!report) return "  No patrol data.";

  const lines = [];
  const s = report.summary || {};

  lines.push("  AFC-10 Runtime Patrol Loop Report:");
  lines.push(`    timestamp:       ${report.timestamp}`);
  lines.push(`    dry_run:         ${s.dry_run ? "yes" : "no"}`);
  lines.push(`    total_findings:  ${s.total_findings}`);
  lines.push(`    safe_actions:    ${s.safe_actions}`);
  lines.push(`    needs_review:    ${s.needs_review}`);
  lines.push("");

  lines.push("  Findings by Category:");
  const cats = s.categories || {};
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${cat}: ${count}`);
  }
  lines.push("");

  const stalled = report.findings?.stalled_tasks || [];
  if (stalled.length > 0) {
    lines.push("  Stalled Tasks:");
    for (const f of stalled.slice(0, 8)) {
      lines.push(`    [${f.level}] ${f.description}`);
    }
    if (stalled.length > 8) lines.push(`    ... and ${stalled.length - 8} more`);
    lines.push("");
  }

  const mis = report.findings?.misclassified_tasks || [];
  if (mis.length > 0) {
    lines.push("  Misclassified Tasks:");
    for (const f of mis.slice(0, 5)) {
      lines.push(`    [${f.level}] ${f.description}`);
    }
    if (mis.length > 5) lines.push(`    ... and ${mis.length - 5} more`);
    lines.push("");
  }

  const blockerFindings = report.findings?.blockers || [];
  if (blockerFindings.length > 0) {
    lines.push("  Review/Repair/Integration Blockers:");
    for (const f of blockerFindings.slice(0, 8)) {
      lines.push(`    [${f.level}] ${f.description}`);
    }
    if (blockerFindings.length > 8) lines.push(`    ... and ${blockerFindings.length - 8} more`);
    lines.push("");
  }

  const me = report.findings?.missing_evidence || [];
  if (me.length > 0) {
    lines.push("  Missing Evidence:");
    for (const f of me.slice(0, 5)) {
      lines.push(`    [${f.level}] ${f.description}`);
    }
    if (me.length > 5) lines.push(`    ... and ${me.length - 5} more`);
    lines.push("");
  }

  const dirty = report.findings?.dirty_canonical_repo || [];
  if (dirty.length > 0) {
    lines.push("  Dirty Canonical Repo:");
    for (const f of dirty) {
      lines.push(`    [${f.level}] ${f.description}`);
      if (f.recommended_action) lines.push(`      -> ${f.recommended_action.description}`);
    }
    lines.push("");
  }

  const missing = report.findings?.missing_afc_tasks || [];
  if (missing.length > 0) {
    lines.push("  Missing AFC Tasks:");
    for (const f of missing.slice(0, 5)) {
      lines.push(`    [${f.level}] ${f.description}`);
    }
    if (missing.length > 5) lines.push(`    ... and ${missing.length - 5} more`);
    lines.push("");
  }

  const actions = report.recovery_actions || [];
  if (actions.length > 0) {
    lines.push("  Patrol Recovery Actions:");
    for (const ra of actions.slice(0, 10)) {
      lines.push(`    ${ra.is_dry_run ? "[DRY] " : ""}[${ra.safety}] ${ra.action} — ${ra.description}`);
    }
    if (actions.length > 10) lines.push(`    ... and ${actions.length - 10} more`);
  }

  return lines.join("\n");
}
