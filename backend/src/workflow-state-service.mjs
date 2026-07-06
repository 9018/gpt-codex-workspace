/**
 * workflow-state-service.mjs
 *
 * Manages GPTWork workflow state files, fingerprint idempotency,
 * proposal generation, and task creation for one-click advance.
 *
 * State files are stored at .gptwork/workflows/<workflow_id>.json
 * outside the source tree, following project convention.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { validateResultContract } from "./task-result-status.mjs";
import { evaluateAcceptance } from "./acceptance-policy.mjs";
import { TASK_STATUSES, isHumanReviewStatus, normalizeTaskStatus } from "./task-status-taxonomy.mjs";
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function workflowsDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "workflows");
}

function workflowStatePath(workspaceRoot, workflowId) {
  return join(workflowsDir(workspaceRoot), `${workflowId}.json`);
}

// ---------------------------------------------------------------------------
// Workflow state CRUD
// ---------------------------------------------------------------------------

function ensureWorkflowsDir(workspaceRoot) {
  const dir = workflowsDir(workspaceRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadWorkflowState(workspaceRoot, workflowId) {
  const path = workflowStatePath(workspaceRoot, workflowId);
  if (!existsSync(path)) {
    return createEmptyWorkflowState(workflowId);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return createEmptyWorkflowState(workflowId);
  }
}

export function saveWorkflowState(workspaceRoot, workflowId, state) {
  ensureWorkflowsDir(workspaceRoot);
  state.updated_at = new Date().toISOString();
  writeFileSync(
    workflowStatePath(workspaceRoot, workflowId),
    JSON.stringify(state, null, 2),
    "utf8"
  );
  return state;
}

export function createEmptyWorkflowState(workflowId) {
  return {
    workflow_id: workflowId || "default",
    name: "Default Workflow",
    current_phase: "task_execution",
    last_task_id: null,
    last_known_good_commit: null,
    latest_running_commit: null,
    manual_results: [],
    proposals: [],
    created_task_ids: [],
    updated_at: null,
  };
}

// ---------------------------------------------------------------------------
// Stable fingerprint computation (idempotency)
// ---------------------------------------------------------------------------

export function computeFingerprint({
  workflowId,
  taskId,
  manualVerdict,
  manualNote,
  runningCommit,
  taskResultCommit,
  nextActionType,
}) {
  const h = createHash("sha256");
  h.update(String(workflowId || "default"));
  h.update("|");
  h.update(String(taskId || "none"));
  h.update("|");
  h.update(String(manualVerdict || "none"));
  h.update("|");
  // Hash the note so content changes produce different fingerprints
  const noteHash = createHash("sha256").update(String(manualNote || "")).digest("hex");
  h.update(noteHash);
  h.update("|");
  h.update(String(runningCommit || "none"));
  h.update("|");
  h.update(String(taskResultCommit || "none"));
  h.update("|");
  h.update(String(nextActionType || "none"));
  return "wf_" + h.digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Latest task helper
// ---------------------------------------------------------------------------

export async function getLatestCodexTask(store) {
  const state = await store.load();
  const tasks = (state.tasks || [])
    .filter((t) => t.assignee === "codex" || t.assignee === "")
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return bTime - aTime;
    });
  return tasks[0] || null;
}

export async function resolveTask(store, taskId) {
  if (!taskId || taskId === "latest") {
    return getLatestCodexTask(store);
  }
  const state = await store.load();
  const tasks = state.tasks || [];
  const task = tasks.find((t) => t.id === taskId);
  return task || null;
}

// ---------------------------------------------------------------------------
// Gather workflow diagnostics state
// ---------------------------------------------------------------------------

export async function collectWorkflowDiagnostics({
  store,
  config,
  workerState,
  collectWorkerQueueCounts,
  task,
  workflowId,
}) {
  const { collectRuntimeGitInfoCached } = await import("./diagnostics-service.mjs");
  const { getRepoLockSummary } = await import("./repo-lock.mjs");
  const { workerStatusExtendedSnapshot } = await import("./codex-worker-state.mjs");

  const repoDir = config?.defaultRepoPath || null;
  const gitInfo = repoDir ? await collectRuntimeGitInfoCached(repoDir) : { repo_head: null, remote_head: null, running_commit: null, worktree_dirty: false, dirty_paths: [] };
  const lockSummary = await getRepoLockSummary(config?.defaultWorkspaceRoot);
  const queueCounts = await collectWorkerQueueCounts(store);
  const workerSnapshot = workerStatusExtendedSnapshot(workerState);

  return {
    workflow_id: workflowId || "default",
    latest_task: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
          mode: task.mode,
          assignee: task.assignee,
          created_at: task.created_at,
          updated_at: task.updated_at,
          result: task.result || null,
          reviewer_decision: task.result?.reviewer_decision || null,
          acceptance_findings: Array.isArray(task.result?.acceptance_findings) ? task.result.acceptance_findings : [],
          next_tasks: Array.isArray(task.result?.next_tasks) ? task.result.next_tasks : [],
          repair_proposal: task.result?.repair_proposal || null,
          changed_files: task.result?.changed_files || null,
          commit: task.result?.commit || null,
          tests: task.result?.tests || null,
          summary: task.result?.summary || null,
        }
      : null,
    runtime: {
      restart_required: gitInfo.running_commit && gitInfo.repo_head ? (gitInfo.running_commit !== gitInfo.repo_head) : false,
      running_commit: gitInfo.running_commit,
      repo_head: gitInfo.repo_head,
      remote_head: gitInfo.remote_head,
    },
    worktree: {
      dirty: gitInfo.worktree_dirty,
      dirty_paths: gitInfo.dirty_paths || [],
    },
    repo_locks: {
      active: lockSummary.active_repo_locks,
      stale: lockSummary.stale_repo_locks,
      details: lockSummary.locks || [],
    },
    worker: workerSnapshot,
    queue: queueCounts,
  };
}

// ---------------------------------------------------------------------------
// Proposal generation (decision rules)
// ---------------------------------------------------------------------------

const BLOCKING_ACCEPTANCE_STATUSES = new Set(["needs_fix", "rejected", "failed", "blocked"]);
const AUTO_FINALIZE_CONVERGENCE_ACTION = "auto_finalize_convergence";

function normalizeDecisionStatus(decision) {
  if (!decision || typeof decision !== "object") return null;
  return decision.status || decision.verdict || decision.outcome || null;
}

/**
 * P0-AFC5: Prefer canonical unified_decision over raw acceptance findings.
 * When a task result carries a unified_decision, the downstream proposal
 * logic (repair, review, or auto-accept) MUST be driven by that canonical
 * outcome, not by stale raw acceptance_findings left from earlier cycles.
 */
function normalizeFromUnifiedDecision(unifiedDecision) {
  if (!unifiedDecision || typeof unifiedDecision !== 'object') return null;

  const uStatus = unifiedDecision.status;

  // Completed unified_decision → no blockers regardless of raw findings
  if (uStatus === 'completed' && unifiedDecision.blocking_passed !== false) {
    return {
      passed: true,
      status: 'accepted',
      reviewer_decision: {
        status: 'accepted',
        passed: true,
        blocking_count: 0,
        residual_count: 0,
      },
      acceptance_findings: [],
      next_tasks: [],
      repair_proposals: [],
      blocking_count: 0,
      residual_count: 0,
      from_canonical_decision: true,
    };
  }

  // Repair / waiting_for_repair unified_decision → use repairable_blockers
  if (uStatus === 'waiting_for_repair' || unifiedDecision.requires_repair === true) {
    const repairableBlockers = Array.isArray(unifiedDecision.repairable_blockers)
      ? unifiedDecision.repairable_blockers
      : [];
    return {
      passed: false,
      status: 'needs_fix',
      reviewer_decision: {
        status: 'needs_fix',
        passed: false,
        blocking_count: repairableBlockers.length,
        residual_count: 0,
      },
      acceptance_findings: repairableBlockers.map(b => ({
        severity: b.severity || 'blocker',
        code: b.code || 'repairable',
        message: b.message || '',
        source: b.source || 'unified_decision',
      })),
      next_tasks: [],
      repair_proposals: [],
      blocking_count: repairableBlockers.length,
      residual_count: 0,
      from_canonical_decision: true,
    };
  }

  return null;
}

function normalizeAcceptanceForResult(result = {}) {
  // P0-AFC5: Canonical unified_decision takes precedence over raw findings.
  const fromUnified = normalizeFromUnifiedDecision(result.unified_decision);
  if (fromUnified) return fromUnified;
  const findings = Array.isArray(result.acceptance_findings) ? result.acceptance_findings : [];
  const policy = evaluateAcceptance({ findings });
  const suppliedDecision = result.reviewer_decision && typeof result.reviewer_decision === "object" ? result.reviewer_decision : null;
  const suppliedStatus = normalizeDecisionStatus(suppliedDecision);
  const hasBlockingFindings = policy.blocking_count > 0;
  const decisionPassed = suppliedDecision?.passed === true || suppliedDecision?.accepted === true || suppliedStatus === "accepted" || suppliedStatus === "pass" || suppliedStatus === "passed" || suppliedStatus === "accepted_with_followups";
  const decisionBlocks = suppliedDecision?.passed === false || BLOCKING_ACCEPTANCE_STATUSES.has(suppliedStatus);
  const passed = hasBlockingFindings ? false : (decisionBlocks ? policy.passed : (decisionPassed || policy.passed));
  const reviewer_decision = suppliedDecision || {
    status: policy.status,
    passed: policy.passed,
    blocking_count: policy.blocking_count,
    residual_count: policy.residual_count,
  };
  const status = passed ? (policy.residual_count > 0 ? "accepted_with_followups" : "accepted") : "needs_fix";

  return {
    passed,
    status,
    reviewer_decision: {
      ...reviewer_decision,
      status,
      passed,
      blocking_count: policy.blocking_count,
      residual_count: policy.residual_count,
    },
    acceptance_findings: findings,
    next_tasks: Array.isArray(result.next_tasks) && result.next_tasks.length > 0 ? result.next_tasks : policy.next_tasks,
    repair_proposals: Array.isArray(result.repair_proposal?.repair_proposals) ? result.repair_proposal.repair_proposals : policy.repair_proposals,
    blocking_count: policy.blocking_count,
    residual_count: policy.residual_count,
  };
}

function withRuntimeDirtyFinding(result = {}, diagnostics = {}) {
  const findings = Array.isArray(result.acceptance_findings) ? [...result.acceptance_findings] : [];
  if (diagnostics?.worktree?.dirty) {
    const dirtyPaths = Array.isArray(diagnostics.worktree.dirty_paths) ? diagnostics.worktree.dirty_paths : [];
    findings.push({
      severity: "blocker",
      code: "dirty_worktree_after_codex",
      message: dirtyPaths.length > 0
        ? `Worktree is dirty after task completion: ${dirtyPaths.slice(0, 5).join(", ")}`
        : "Worktree is dirty after task completion.",
      source: "workflow_runtime",
      evidence: { dirty_paths: dirtyPaths },
    });
  }
  return { ...result, acceptance_findings: findings };
}

function buildAcceptanceRepairTask({ task, acceptance, manualNote }) {
  const failedCriteria = acceptance.acceptance_findings.filter((finding) => finding.severity === "blocker" || finding.severity === "major");
  const repairProposal = {
    source_task_id: task.id,
    source_goal_id: task.goal_id || null,
    reviewer_decision: acceptance.reviewer_decision,
    acceptance_findings: acceptance.acceptance_findings,
    failed_criteria: failedCriteria,
    repair_proposals: acceptance.repair_proposals,
  };
  const lines = [
    `Repair acceptance failures for task: ${task.id}`,
    task.title,
    "",
    task.goal_id ? `Source goal: ${task.goal_id}` : "",
    task.result?.summary ? `Original summary: ${task.result.summary}` : "",
    task.result?.commit ? `Original commit: ${task.result.commit}` : "",
    "",
    "Acceptance decision:",
    JSON.stringify(acceptance.reviewer_decision, null, 2),
    "",
    "Blocking findings:",
    JSON.stringify(failedCriteria, null, 2),
    "",
    "Repair proposal:",
    JSON.stringify(repairProposal, null, 2),
    "",
    manualNote ? `Additional note: ${manualNote}` : "",
    "Implement the smallest fix that resolves the blocker/major findings, rerun verification, and report a new reviewer_decision.",
  ].filter(Boolean);

  return {
    title: `Repair acceptance findings: ${task.title}`,
    description: lines.join("\n"),
    assignee: "codex",
    project_id: task.project_id || "default",
    workspace_id: task.workspace_id || "hosted-default",
    mode: task.mode || "builder",
    source_task_id: task.id,
    source_goal_id: task.goal_id || null,
    repair_proposal: repairProposal,
  };
}

function explicitVerificationPassed(result = {}) {
  return result?.verification?.passed === true || result?.final_verification?.passed === true;
}

function explicitVerificationFailed(result = {}) {
  return result?.verification?.passed === false || result?.final_verification?.passed === false;
}

/**
 * Check whether the result carries authoritative terminal evidence that
 * overrides stale fallback verification fields (`verification.passed`,
 * `final_verification.passed`) from earlier cycles.
 *
 * When a task has been accepted, integrated, restarted, or auto-accepted,
 * those fields take precedence over legacy verification flags that may
 * have been set by a previous run whose state was later superseded.
 */
function hasAuthoritativeTerminalEvidence(result = {}) {
  return result?.auto_accepted === true
    || result?.reviewer_decision?.passed === true
    || result?.reviewer_decision?.status === "accepted"
    || result?.reviewer_decision?.status === "accepted_with_followups";
}

function completedPassedFinalizationProposal({ task, diagnostics }) {
  const result = task?.result;
  if (!result) {
    return {
      next_action: "needs_gptchat_decision",
      proposed_next_task: null,
      recommendation: `Task "${task?.id || "unknown"}" is completed but has no result. GPTChat should review.`,
      needs_gptchat_decision: true,
    };
  }

  const resultWithRuntimeFindings = withRuntimeDirtyFinding(result, diagnostics);
  const validation = validateResultContract(resultWithRuntimeFindings, { skipWorktreeCheck: true });
  const acceptance = normalizeAcceptanceForResult(resultWithRuntimeFindings);

  // Prefer authoritative terminal evidence (auto_accepted, reviewer_decision
  // passed/accepted) over stale fallback verification fields from earlier
  // cycles. A task that has been accepted, integrated, and restarted with
  // zero blockers should not be held back by outdated verification flags.
  const hasAuthoritative = hasAuthoritativeTerminalEvidence(resultWithRuntimeFindings);

  if (!hasAuthoritative) {
    if (explicitVerificationFailed(resultWithRuntimeFindings)) {
      return {
        next_action: "needs_gptchat_decision",
        proposed_next_task: null,
        recommendation: `Task "${task.title}" completed but verification failed. Keep acceptance checks in place and review or repair before finalization.`,
        needs_gptchat_decision: true,
        acceptance,
      };
    }

    if (!explicitVerificationPassed(resultWithRuntimeFindings)) {
      return {
        next_action: "needs_gptchat_decision",
        proposed_next_task: null,
        recommendation: `Task "${task.title}" completed without explicit passed verification evidence. GPTChat should review before finalization.`,
        needs_gptchat_decision: true,
        acceptance,
        diagnosis_codes: ["verification_not_passed"],
      };
    }
  }

  if (!validation.valid) {
    const issues = validation.warnings.length > 0
      ? validation.warnings.join("; ")
      : validation.diagnosis_codes.join(", ");
    return {
      next_action: "needs_gptchat_decision",
      proposed_next_task: null,
      recommendation: `Task "${task.title}" completed but result contract still has issues: ${issues}. GPTChat should review before finalization.`,
      needs_gptchat_decision: true,
      acceptance,
      diagnosis_codes: validation.diagnosis_codes,
    };
  }

  if (!acceptance.passed) {
    return {
      next_action: "needs_gptchat_decision",
      proposed_next_task: null,
      recommendation: `Task "${task.title}" completed with blocker/major acceptance findings. Keep manual review or repair before finalization.`,
      needs_gptchat_decision: true,
      acceptance,
    };
  }

  return {
    next_action: AUTO_FINALIZE_CONVERGENCE_ACTION,
    proposed_next_task: null,
    recommendation: `Task "${task.title}" passed verification and only finalization/convergence remains. Rerun acceptance and finalize automatically.`,
    needs_gptchat_decision: false,
    auto_finalizing: true,
    acceptance,
  };
}

export function generateProposal({
  diagnostics,
  task,
  manualVerdict,
  manualNote,
}) {
  const isSafe =
    !diagnostics.worker.running &&
    diagnostics.repo_locks.active === 0 &&
    !diagnostics.worktree.dirty &&
    !diagnostics.runtime.restart_required;

  // Review-state tasks must consume acceptance metadata before global runtime
  // safety gates. Auto-accepting a valid review task only updates task/goal
  // state; creating new repair work is gated later by workflow_advance.
  if (isHumanReviewStatus(task?.status)) {
    const result = task.result;

    if (!result) {
      return {
        next_action: "needs_gptchat_decision",
        proposed_next_task: null,
        recommendation: `Task "${task.id}" is waiting_for_review but has no result. GPTChat should review.`,
        needs_gptchat_decision: true,
      };
    }

    const resultWithRuntimeFindings = withRuntimeDirtyFinding(result, diagnostics);
    const validation = validateResultContract(resultWithRuntimeFindings, { skipWorktreeCheck: true });
    const acceptance = normalizeAcceptanceForResult(resultWithRuntimeFindings);

    if (validation.valid && !acceptance.passed) {
      const proposed_next_task = buildAcceptanceRepairTask({ task, acceptance, manualNote });
      return {
        next_action: "create_repair_task",
        proposed_next_task,
        recommendation: `Task "${task.title}" has blocker/major acceptance findings. Proposed automatic repair task.`,
        needs_gptchat_decision: false,
        repair_proposal: proposed_next_task.repair_proposal,
        acceptance,
      };
    }

    if (validation.valid && acceptance.passed) {
      return {
        next_action: "auto_accepted",
        proposed_next_task: null,
        recommendation: `Task "${task.title}" result and acceptance verdict are valid. Auto-accepted.`,
        needs_gptchat_decision: false,
        auto_accepted: true,
        acceptance,
      };
    }

    const issues = validation.warnings.length > 0
      ? validation.warnings.join("; ")
      : validation.diagnosis_codes.join(", ");
    return {
      next_action: "needs_gptchat_decision",
      proposed_next_task: null,
      recommendation: `Task "${task.title}" has result issues: ${issues}. GPTChat should review.`,
      needs_gptchat_decision: true,
      diagnosis_codes: validation.diagnosis_codes,
    };
  }

  // Unsafe state: blocked
  if (!isSafe) {
    const reasons = [];
    if (diagnostics.worker.running) reasons.push("worker is currently running");
    if (diagnostics.repo_locks.active > 0) reasons.push(`${diagnostics.repo_locks.active} active repo lock(s)`);
    if (diagnostics.worktree.dirty) reasons.push("worktree is dirty");
  if (diagnostics.runtime.restart_required) {
    reasons.push("runtime restart required: running_commit (" + (diagnostics.runtime.running_commit || "?").slice(0, 12) + ") does not match repo_head (" + (diagnostics.runtime.repo_head || "?").slice(0, 12) + ")");
  }
    return {
      next_action: "blocked",
      proposed_next_task: null,
      recommendation: `Cannot advance workflow: ${reasons.join("; ")}.`,
      needs_gptchat_decision: true,
    };
  }

  // No task to evaluate
  if (!task) {
    return {
      next_action: "needs_gptchat_decision",
      proposed_next_task: null,
      recommendation: "No task found to evaluate. Define a new task or check for existing tasks.",
      needs_gptchat_decision: true,
    };
  }

  // Task failed during execution (not completed)
  if (task.status !== "completed" && task.status === "failed") {
    return {
      next_action: "create_fix_task",
      proposed_next_task: {
        title: `Fix execution failure: ${task.title}`,
        description: [
          `Execution-failure investigation for task: ${task.id}`,
          task.title,
          "",
          "Task failed during execution. Investigate and fix based on the result summary below:",
          task.result?.summary ? `Result summary: ${task.result.summary}` : "No result summary available.",
          task.result?.warnings && Array.isArray(task.result.warnings) && task.result.warnings.length > 0
            ? `Warnings: ${task.result.warnings.join("; ")}`
            : "",
          "",
          manualNote ? `User note: ${manualNote}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        assignee: "codex",
      },
      recommendation: "The latest task failed during execution. Proposed a fix/investigation task.",
      needs_gptchat_decision: false,
    };
  }

  // Task completed but verdict was failed or partial
  if (task.status === "completed" && (manualVerdict === "failed" || manualVerdict === "partial")) {
    const verb = manualVerdict === "failed" ? "failed" : "was only partially accepted";
    const taskType = manualVerdict === "failed" ? "修复" : "收敛";
    return {
      next_action: "create_fix_task",
      proposed_next_task: {
        title: manualVerdict === "failed"
          ? `Fix issues: ${task.title}`
          : `Converge remaining issues: ${task.title}`,
        description: [
          `User review ${verb} for task: ${task.id}`,
          task.title,
          "",
          `Result commit: ${task.result?.commit || "unknown"}`,
          task.result?.summary ? `Original summary: ${task.result.summary}` : "",
          "",
          manualNote
            ? `User feedback: ${manualNote}`
            : `User indicated the task ${verb} but did not provide specific notes.`,
          "",
          "Create a targeted ${taskType} task addressing the user's feedback.",
        ]
          .filter(Boolean)
          .join("\n"),
        assignee: "codex",
      },
      recommendation: `Task was completed but user review ${verb}. Proposed a targeted ${taskType} task.`,
      needs_gptchat_decision: false,
    };
  }

  // P0: Task completed, passed verification, and no blocker/major findings →
  // automatic finalization/convergence. Acceptance is rerun above before this
  // route is allowed; failed verification and mixed blockers stay manual.
  if (task.status === "completed" && manualVerdict === "passed") {
    return completedPassedFinalizationProposal({ task, diagnostics });
  }

  // Catch-all: task is in progress or other status
  return {
    next_action: "needs_gptchat_decision",
    proposed_next_task: null,
    recommendation: `Task "${task.id}" status is "${task.status}". GPTChat should determine the appropriate next action.`,
    needs_gptchat_decision: true,
  };
}

function nextQueuedCodexTask(tasks = [], completedTaskId = null) {
  return (tasks || [])
    .filter((task) => task?.id !== completedTaskId)
    .filter((task) => task.assignee === "codex" || !task.assignee)
    .filter((task) => normalizeTaskStatus(task.status) === TASK_STATUSES.QUEUED)
    .sort((a, b) => {
      const aTime = Date.parse(a.created_at || a.updated_at || "") || 0;
      const bTime = Date.parse(b.created_at || b.updated_at || "") || 0;
      return aTime - bTime;
    })[0] || null;
}

export async function autoFinalizeConvergenceAndAdvanceQueue({ store, task, proposal } = {}) {
  if (!task) return { auto_finalized: false, advanced_task_id: null, error: "No task provided" };
  if (proposal?.next_action !== AUTO_FINALIZE_CONVERGENCE_ACTION) {
    return { auto_finalized: false, advanced_task_id: null, error: "Proposal is not auto finalization convergence" };
  }

  const state = await store.load();
  state.activities ||= [];
  const storedTask = (state.tasks || []).find((item) => item.id === task.id);
  if (!storedTask) return { auto_finalized: false, advanced_task_id: null, error: `Task not found: ${task.id}` };

  const now = new Date().toISOString();
  storedTask.result = storedTask.result || {};
  storedTask.result.convergence = {
    ...(storedTask.result.convergence || {}),
    status: "finalizing",
    next_action: AUTO_FINALIZE_CONVERGENCE_ACTION,
    finalized_at: now,
  };
  storedTask.result.auto_finalized = true;
  storedTask.result.final_acceptance = proposal.acceptance || null;
  storedTask.logs = [...(storedTask.logs || []), {
    time: now,
    message: "[workflow] auto finalization convergence: acceptance rerun passed; queue may advance",
  }];
  storedTask.updated_at = now;
  state.activities.push({ time: now, type: "task.auto_finalized", task_id: storedTask.id, status: storedTask.status });

  const nextTask = nextQueuedCodexTask(state.tasks, storedTask.id);
  if (nextTask) {
    nextTask.status = TASK_STATUSES.ASSIGNED;
    nextTask.logs = [...(nextTask.logs || []), {
      time: now,
      message: `[workflow] assigned after auto finalization convergence of ${storedTask.id}`,
    }];
    nextTask.updated_at = now;
    state.activities.push({ time: now, type: "task.assigned", task_id: nextTask.id, status: nextTask.status, reason: "auto_finalization_convergence" });
  }

  await store.save(state);
  return { auto_finalized: true, advanced_task_id: nextTask?.id || null };
}

// ---------------------------------------------------------------------------
// Create a task from a proposal (for apply mode)
// ---------------------------------------------------------------------------

export async function createProposalTask(store, config, proposal, context) {
  const { createTask } = await import("./goal-task-lifecycle.mjs");
  if (!proposal.proposed_next_task) {
    throw new Error("Cannot create task: proposal has no proposed_next_task");
  }
  const result = await createTask(store, config, proposal.proposed_next_task, context);
  return result.task;
}

// ---------------------------------------------------------------------------
// Find existing proposal by fingerprint
// ---------------------------------------------------------------------------

export function findExistingProposal(workflowState, fingerprint) {
  return (workflowState.proposals || []).find((p) => p.fingerprint === fingerprint) || null;
}

export function findExistingResult(workflowState, fingerprint) {
  return (workflowState.manual_results || []).find((r) => r.fingerprint === fingerprint) || null;
}

// ---------------------------------------------------------------------------
// Store a manual result
// ---------------------------------------------------------------------------

export function storeManualResult(workflowState, { taskId, verdict, note, fingerprint }) {
  workflowState.manual_results = workflowState.manual_results || [];
  workflowState.manual_results.push({
    task_id: taskId,
    verdict,
    note: note || "",
    fingerprint,
    recorded_at: new Date().toISOString(),
  });
  workflowState.last_task_id = taskId;
  return workflowState;
}

// ---------------------------------------------------------------------------
// Store a proposal
// ---------------------------------------------------------------------------

export function storeProposal(workflowState, proposal) {
  workflowState.proposals = workflowState.proposals || [];
  workflowState.proposals.push(proposal);
  return workflowState;
}

// ---------------------------------------------------------------------------
// Store a created task id
// ---------------------------------------------------------------------------

export function storeCreatedTaskId(workflowState, taskId) {
  workflowState.created_task_ids = workflowState.created_task_ids || [];
  if (!workflowState.created_task_ids.includes(taskId)) {
    workflowState.created_task_ids.push(taskId);
  }
  return workflowState;
}


// ---------------------------------------------------------------------------
// Auto-accept: upgrade a waiting_for_review task to completed
// Called by both workflow_advance (apply mode) and workflow_status.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.store       — persistent store
 * @param {object} opts.config      — server config
 * @param {object} opts.task        — current task
 * @param {object} opts.diagnostics — workflow diagnostics snapshot
 * @returns {Promise<{auto_accepted: boolean, error?: string}>}
 */
export async function autoAcceptTask({ store, config, task, diagnostics }) {
  if (!task) return { auto_accepted: false, error: "No task provided" };
  if (!isHumanReviewStatus(task.status)) {
    return { auto_accepted: false, error: `Task status is "${task.status}", not "waiting_for_review"` };
  }
  if (!diagnostics) return { auto_accepted: false, error: "No diagnostics provided" };

  const result = task.result;
  if (!result) return { auto_accepted: false, error: "Task has no result" };

  const resultWithRuntimeFindings = withRuntimeDirtyFinding(result, diagnostics);
  const validation = validateResultContract(resultWithRuntimeFindings, { skipWorktreeCheck: true });
  const acceptance = normalizeAcceptanceForResult(resultWithRuntimeFindings);
  if (!validation.valid) {
    return { auto_accepted: false, error: `Result contract invalid: ${validation.warnings.join("; ")}` };
  }
  if (!acceptance.passed) {
    return { auto_accepted: false, error: "Acceptance decision requires repair" };
  }

  // All conditions met — perform auto-accept
  const { updateTask, updateGoalStatus } = await import("./task-lifecycle.mjs");

  await updateTask(store, task.id, (t) => {
    t.status = "completed";
    t.logs = [...(t.logs || []), {
      time: new Date().toISOString(),
      message: "[workflow] auto-accepted: result contract valid, tests passed, commit present, worktree clean",
    }];
    if (t.result) {
      t.result.auto_accepted = true;
      t.result.accepted_at = new Date().toISOString();
      t.result.reviewer_decision = acceptance.reviewer_decision;
      t.result.acceptance_findings = acceptance.acceptance_findings;
      t.result.next_tasks = acceptance.next_tasks;
    }
  });

  // Also update goal status if a goal is associated with this task
  try {
    const state = await store.load();
    const goal = (state.goals || []).find((g) => g.task_id === task.id);
    if (goal) {
      await updateGoalStatus(store, goal.id, "completed");
    }
  } catch {
    // Goal update is best-effort
  }

  return { auto_accepted: true };
}
