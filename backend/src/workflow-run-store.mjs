/**
 * workflow-run-store.mjs
 *
 * Persistent workflow_run snapshots for the cross-cutting GPTWork lifecycle.
 * The run model is intentionally additive: legacy task/goal/queue state remains
 * the source of execution truth while this store records the unified step,
 * blocker, and event trail used by workflow diagnostics.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const WORKFLOW_RUN_SCHEMA_VERSION = 1;

export const WORKFLOW_RUN_STATUSES = Object.freeze({
  CREATED: "created",
  QUEUED: "queued",
  RUNNING: "running",
  BLOCKED: "blocked",
  WAITING_FOR_REVIEW: "waiting_for_review",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TERMINAL_STATUSES = new Set([
  WORKFLOW_RUN_STATUSES.COMPLETED,
  WORKFLOW_RUN_STATUSES.FAILED,
  WORKFLOW_RUN_STATUSES.CANCELLED,
]);

const LEGAL_TRANSITIONS = new Map([
  [WORKFLOW_RUN_STATUSES.CREATED, new Set([WORKFLOW_RUN_STATUSES.QUEUED, WORKFLOW_RUN_STATUSES.RUNNING, WORKFLOW_RUN_STATUSES.BLOCKED, WORKFLOW_RUN_STATUSES.CANCELLED])],
  [WORKFLOW_RUN_STATUSES.QUEUED, new Set([WORKFLOW_RUN_STATUSES.RUNNING, WORKFLOW_RUN_STATUSES.BLOCKED, WORKFLOW_RUN_STATUSES.CANCELLED])],
  [WORKFLOW_RUN_STATUSES.RUNNING, new Set([WORKFLOW_RUN_STATUSES.BLOCKED, WORKFLOW_RUN_STATUSES.WAITING_FOR_REVIEW, WORKFLOW_RUN_STATUSES.COMPLETED, WORKFLOW_RUN_STATUSES.FAILED, WORKFLOW_RUN_STATUSES.CANCELLED])],
  [WORKFLOW_RUN_STATUSES.BLOCKED, new Set([WORKFLOW_RUN_STATUSES.QUEUED, WORKFLOW_RUN_STATUSES.RUNNING, WORKFLOW_RUN_STATUSES.WAITING_FOR_REVIEW, WORKFLOW_RUN_STATUSES.COMPLETED, WORKFLOW_RUN_STATUSES.FAILED, WORKFLOW_RUN_STATUSES.CANCELLED])],
  [WORKFLOW_RUN_STATUSES.WAITING_FOR_REVIEW, new Set([WORKFLOW_RUN_STATUSES.RUNNING, WORKFLOW_RUN_STATUSES.BLOCKED, WORKFLOW_RUN_STATUSES.COMPLETED, WORKFLOW_RUN_STATUSES.FAILED, WORKFLOW_RUN_STATUSES.CANCELLED])],
  [WORKFLOW_RUN_STATUSES.COMPLETED, new Set()],
  [WORKFLOW_RUN_STATUSES.FAILED, new Set()],
  [WORKFLOW_RUN_STATUSES.CANCELLED, new Set()],
]);

function nowIso() {
  return new Date().toISOString();
}

function workflowRunsDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork", "workflow_runs");
}

function safeRunId(runId) {
  return String(runId || "default").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function workflowRunPath(workspaceRoot, runId) {
  return join(workflowRunsDir(workspaceRoot), `${safeRunId(runId)}.json`);
}

function ensureWorkflowRunsDir(workspaceRoot) {
  const dir = workflowRunsDir(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWorkflowRun(workspaceRoot, run) {
  ensureWorkflowRunsDir(workspaceRoot);
  writeFileSync(workflowRunPath(workspaceRoot, run.run_id), JSON.stringify(run, null, 2), "utf8");
  return run;
}

function buildEvent(type, data = {}, at = nowIso()) {
  return {
    event_id: `wfre_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type,
    created_at: at,
    ...data,
  };
}

function normalizeBlocker(blocker, reason) {
  if (!blocker && !reason) return null;
  if (blocker && typeof blocker === "object") {
    return {
      code: blocker.code || "blocked",
      detail: blocker.detail || blocker.reason || reason || "blocked",
      source: blocker.source || "workflow_run",
    };
  }
  return { code: "blocked", detail: String(reason || blocker), source: "workflow_run" };
}

export function loadWorkflowRun(workspaceRoot, runId) {
  const path = workflowRunPath(workspaceRoot, runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function createWorkflowRun(workspaceRoot, attrs = {}) {
  const at = nowIso();
  const runId = attrs.run_id || attrs.task_id || attrs.goal_id || `wfrun_${randomUUID()}`;
  const blocker = normalizeBlocker(attrs.blocker, attrs.blocking_reason);
  const run = {
    schema_version: WORKFLOW_RUN_SCHEMA_VERSION,
    run_id: runId,
    workflow_id: attrs.workflow_id || "default",
    goal_id: attrs.goal_id || null,
    task_id: attrs.task_id || null,
    queue_id: attrs.queue_id || null,
    status: attrs.status || WORKFLOW_RUN_STATUSES.CREATED,
    current_step: attrs.current_step || "created",
    blocking_reason: blocker?.detail || attrs.blocking_reason || null,
    blocker,
    refs: attrs.refs || {},
    created_at: at,
    updated_at: at,
    last_event_at: at,
    events: [buildEvent("workflow_run.created", { status: attrs.status || WORKFLOW_RUN_STATUSES.CREATED, current_step: attrs.current_step || "created" }, at)],
  };
  return writeWorkflowRun(workspaceRoot, run);
}

export function ensureWorkflowRun(workspaceRoot, attrs = {}) {
  const runId = attrs.run_id || attrs.task_id || attrs.goal_id;
  const existing = runId ? loadWorkflowRun(workspaceRoot, runId) : null;
  if (existing) return existing;
  return createWorkflowRun(workspaceRoot, attrs);
}

export function validateWorkflowRunTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  const allowed = LEGAL_TRANSITIONS.get(fromStatus);
  if (!allowed || !allowed.has(toStatus)) {
    throw new Error(`illegal workflow_run transition: ${fromStatus} -> ${toStatus}`);
  }
  return true;
}

export function transitionWorkflowRun(workspaceRoot, runId, { to_status, current_step, reason, blocker, refs } = {}) {
  if (!to_status) throw new Error("workflow_run transition requires to_status");
  const run = loadWorkflowRun(workspaceRoot, runId);
  if (!run) throw new Error(`workflow_run not found: ${runId}`);
  const fromStatus = run.status;
  validateWorkflowRunTransition(fromStatus, to_status);
  const at = nowIso();
  const normalizedBlocker = normalizeBlocker(blocker, reason);
  run.status = to_status;
  run.current_step = current_step || run.current_step;
  run.blocker = normalizedBlocker;
  run.blocking_reason = normalizedBlocker?.detail || null;
  if (refs && typeof refs === "object") run.refs = { ...(run.refs || {}), ...refs };
  run.updated_at = at;
  run.last_event_at = at;
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push(buildEvent("workflow_run.transitioned", {
    from_status: fromStatus,
    to_status,
    current_step: run.current_step,
    reason: reason || normalizedBlocker?.detail || null,
  }, at));
  return writeWorkflowRun(workspaceRoot, run);
}

export function appendWorkflowRunEvent(workspaceRoot, runId, type, data = {}) {
  const run = loadWorkflowRun(workspaceRoot, runId);
  if (!run) throw new Error(`workflow_run not found: ${runId}`);
  const at = nowIso();
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push(buildEvent(type, data, at));
  run.updated_at = at;
  run.last_event_at = at;
  return writeWorkflowRun(workspaceRoot, run);
}

export function deriveWorkflowRunStatusFromTask(task) {
  const status = task?.status || "created";
  if (["completed"].includes(status)) return WORKFLOW_RUN_STATUSES.COMPLETED;
  if (["failed", "timed_out"].includes(status)) return WORKFLOW_RUN_STATUSES.FAILED;
  if (["cancelled"].includes(status)) return WORKFLOW_RUN_STATUSES.CANCELLED;
  if (["waiting_for_review", "review", "human_review"].includes(status)) return WORKFLOW_RUN_STATUSES.WAITING_FOR_REVIEW;
  if (["waiting_for_lock", "waiting_for_dependency", "waiting_for_repair", "waiting_for_integration", "blocked"].includes(status)) return WORKFLOW_RUN_STATUSES.BLOCKED;
  if (["queued", "assigned", "draft"].includes(status)) return WORKFLOW_RUN_STATUSES.QUEUED;
  return WORKFLOW_RUN_STATUSES.RUNNING;
}

export function deriveWorkflowRunStepFromTask(task) {
  const status = task?.status || "created";
  if (status === "waiting_for_lock") return "waiting_for_lock";
  if (status === "waiting_for_dependency") return "waiting_for_dependency";
  if (status === "materializing_worktree") return "materializing_worktree";
  if (status === "waiting_for_review") return "reviewer_decision";
  if (status === "waiting_for_repair") return "repair_wait";
  if (status === "waiting_for_integration") return "integration_wait";
  if (status === "verifying") return "verification";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "timed_out") return "failed";
  if (status === "running") return "codex_execution";
  if (status === "queued" || status === "assigned") return "task_queue";
  return status;
}

export function deriveWorkflowRunBlocker({ task, queueItem, diagnostics } = {}) {
  if (task?.lock_blocked_by) return { code: "repo_lock", detail: `repo locked by ${task.lock_blocked_by}`, source: "task" };
  if (task?.blocked_reason) return { code: "task_blocked", detail: task.blocked_reason, source: "task" };
  if (queueItem?.blocked_reason) return { code: "queue_blocked", detail: queueItem.blocked_reason, source: "queue" };
  if (diagnostics?.repo_locks?.active > 0) return { code: "repo_lock", detail: `${diagnostics.repo_locks.active} active repo lock(s)`, source: "repo_locks" };
  if (diagnostics?.worktree?.dirty) return { code: "worktree_dirty", detail: "worktree is dirty", source: "worktree" };
  if (diagnostics?.worker?.running) return { code: "worker_running", detail: "worker is currently running", source: "worker" };
  return null;
}

export function workflowRunStatusView(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    goal_id: run.goal_id,
    task_id: run.task_id,
    queue_id: run.queue_id,
    status: run.status,
    current_step: run.current_step,
    blocking_reason: run.blocking_reason || run.blocker?.detail || null,
    blocker: run.blocker || null,
    event_count: Array.isArray(run.events) ? run.events.length : 0,
    updated_at: run.updated_at || null,
    last_event_at: run.last_event_at || null,
  };
}

export function diagnoseWorkflowRun(workspaceRoot, runId, { now = nowIso(), staleAfterMs = 10 * 60_000 } = {}) {
  const run = loadWorkflowRun(workspaceRoot, runId);
  if (!run) return { run_id: runId, found: false, stale: false, blocking_reason: "workflow_run missing" };
  const lastEventMs = Date.parse(run.last_event_at || run.updated_at || run.created_at || "");
  const nowMs = Date.parse(now);
  const active = !TERMINAL_STATUSES.has(run.status);
  const stale = active && Number.isFinite(lastEventMs) && Number.isFinite(nowMs) && nowMs - lastEventMs > staleAfterMs;
  return {
    ...workflowRunStatusView(run),
    found: true,
    stale,
    active,
    event_count: Array.isArray(run.events) ? run.events.length : 0,
    recovery_hint: stale
      ? `workflow_run ${run.run_id} has no events since ${run.last_event_at || run.updated_at}; inspect task ${run.task_id || "unknown"} and queue state`
      : null,
  };
}
