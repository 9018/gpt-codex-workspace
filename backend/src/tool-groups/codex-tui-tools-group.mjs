/**
 * codex-tui-tools-group.mjs — Codex TUI tool group with worktree-based execution.
 *
 * Startup flow:
 *   1. resolve plan (no git mutation)
 *   2. materialize worktree (git worktree add)
 *   3. verify task worktree is valid
 *   4. cwd = task_worktree_path
 *   5. acquire lock on worktree path
 *   6. start TUI session within worktree
 *
 * Session/Task/Execution persistence includes:
 *   workstream_id, goal_id, task_id, worktree_path, branch,
 *   base_commit, head_commit, session_id.
 *
 * All results and lock releases operate on the task worktree path.
 */

import { execFileSync } from "node:child_process";
import { acquireRepoLock, releaseRepoLock } from "../repo-lock.mjs";
import { findTask, updateTask } from "../task-lifecycle.mjs";
import { ensureTaskGoal } from "../goal-task-lifecycle.mjs";
import { resolveTaskRepositoryPlan, materializeTaskWorktree } from "../task-repo-resolution.mjs";
import { isCodexTuiEnabled } from "../codex-execution-provider.mjs";
import { createExecutionStore } from "../executions/execution-store.mjs";
import {
  getCodexTuiSessionStatus,
  readCodexTuiSession,
  sendCodexTuiSessionInput,
  sendCodexTuiSlashCommand,
  sendCodexTuiTaskDelta,
  startCodexTuiGoalSession,
  stopCodexTuiSession,
} from "../codex-tui-session-manager.mjs";
import { collectCodexTuiCompletion } from "../codex-tui-completion-collector.mjs";
import { isTerminalStatus } from "../task-status-taxonomy.mjs";
import { createCodexTuiSessionStore } from "../codex-tui-session-store.mjs";
import { reconcileTaskRuntime } from "../runtime/task-runtime-reconciler.mjs";
import { validateTaskDelta, renderDeltaInstruction } from "../codex-tui-task-delta.mjs";
import { diagnosticVerificationPassed, reconcileTuiAgentRunsFromProgress } from "../codex-tui-agent-run-reconciler.mjs";
import { ensurePipelineRunsForTask } from "../pipeline-orchestration.mjs";
import { createTaskTransitionService } from "../task-state/task-transition-service.mjs";
import { TASK_EVENTS } from "../task-state/task-transition-events.mjs";
import { verifyAcceptanceContract } from "../acceptance/contract-verifier.mjs";
import { persistTuiTerminalState } from "../codex-tui-evidence-writeback.mjs";


export async function reconcileStoppedTuiTask({ store, taskId, reason = "stopped", hasEvidence = false, transitionService: injectedTransitionService } = {}) {
  if (!store || !taskId) return null;
  let state = typeof store.load === "function" ? await store.load() : null;
  let existingTask = (state?.tasks || []).find((item) => item.id === taskId);
  if (!existingTask && typeof store.mutate === "function") {
    await store.mutate(async (currentState) => {
      state = currentState;
      existingTask = (currentState.tasks || []).find((item) => item.id === taskId);
    });
  }
  if (!existingTask) return null;
  const wasTerminal = isTerminalStatus(existingTask.status);
  let updated = existingTask;

  if (!wasTerminal) {
    const transitionService = injectedTransitionService || createTaskTransitionService({ store });
    const transition = await transitionService.transitionTask({
      task_id: taskId,
      event: reason === "manual_stop"
        ? TASK_EVENTS.CANCEL_REQUESTED
        : (hasEvidence ? TASK_EVENTS.EXECUTION_SESSION_STOPPED : TASK_EVENTS.RUNTIME_LOST),
      expected_statuses: [existingTask.status],
      payload: reason === "manual_stop" ? { requested_by: "gpt_supervisor" } : (hasEvidence ? {} : { repairable: true }),
      reason: `TUI stopped: ${reason}`,
      source: "codex_tui",
      actor: { type: "system", id: "codex_tui_stop" },
      idempotency_key: `tui_stop:${taskId}:${hasEvidence ? "evidence" : "no_evidence"}:${reason}`,
    });
    updated = transition.task || existingTask;
  }

  await store.mutate(async (nextState) => {
    const task = (nextState.tasks || []).find((item) => item.id === taskId);
    if (!task) return;
    task.metadata = { ...(task.metadata || {}) };
    delete task.metadata.tui_session_owner;
    delete task.metadata.manual_tui_session_starting;
    task.updated_at = new Date().toISOString();
    task.logs ||= [];
    task.logs.push({ time: task.updated_at, message: `[tui] stopped: ${reason}; next=${task.status}` });
    nextState.activities ||= [];
    nextState.activities.push({ time: task.updated_at, type: "task.tui_stopped_reconciled", task_id: task.id, status: task.status, reason });
    const queueItem = (nextState.goal_queue || []).find((entry) => entry.task_id === task.id);
    if (queueItem && !wasTerminal) {
      queueItem.status = reason === "manual_stop" ? "cancelled" : (hasEvidence ? "running" : "waiting");
      queueItem.blocked_reason = reason === "manual_stop" ? null : (hasEvidence ? null : `automatic repair after TUI stop: ${reason}`);
      queueItem.updated_at = task.updated_at;
    }
    updated = task;
  });
  return updated;
}

function gitStatusShort(repoPath) {
  try {
    return execFileSync("git", ["status", "--short"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    return [`git_status_unavailable: ${err.message}`];
  }
}

function dirtyPaths(statusLines) {
  return statusLines.map((line) => line.slice(3).trim().split(" -> ").at(-1)).filter(Boolean).sort();
}

function createMutableStoreAdapter(store) {
  if (typeof store?.mutate === "function") return store;
  return {
    ...store,
    async mutate(fn) {
      const state = await store.load();
      const result = await fn(state);
      if (typeof store.save === "function") await store.save();
      return result;
    },
  };
}

function tuiToolMetadata() {
  return {
    modes: ["standard", "operator", "codex", "full"],
    audience: ["chatgpt", "codex", "operator"],
    tags: ["codex", "tui"],
  };
}

export function createCodexTuiToolsGroup({
  tool,
  schema,
  store,
  config,
  registry = null,
  findTaskFn = findTask,
  ensureTaskGoalFn = ensureTaskGoal,
  resolveTaskRepositoryPlanFn = resolveTaskRepositoryPlan,
  materializeTaskWorktreeFn = materializeTaskWorktree,
  acquireRepoLockFn = acquireRepoLock,
  releaseRepoLockFn = releaseRepoLock,
  startCodexTuiGoalSessionFn = startCodexTuiGoalSession,
  getCodexTuiSessionStatusFn = getCodexTuiSessionStatus,
  readCodexTuiSessionFn = readCodexTuiSession,
  sendCodexTuiSessionInputFn = sendCodexTuiSessionInput,
  sendCodexTuiSlashCommandFn = sendCodexTuiSlashCommand,
  sendCodexTuiTaskDeltaFn = sendCodexTuiTaskDelta,
  stopCodexTuiSessionFn = stopCodexTuiSession,
  collectCodexTuiCompletionFn = collectCodexTuiCompletion,
  updateTaskFn = updateTask,
  createExecutionStoreFn = createExecutionStore,
  ensurePipelineRunsForTaskFn = ensurePipelineRunsForTask,
  reconcileTuiAgentRunsFn = reconcileTuiAgentRunsFromProgress,
  transitionService: injectedTransitionService = null,
  workstreamId = null,
} = {}) {
  const metadata = tuiToolMetadata();
  const mutableStore = createMutableStoreAdapter(store);
  const transitionService = injectedTransitionService || createTaskTransitionService({ store: mutableStore });
  const workspaceRoot = config?.defaultWorkspaceRoot || config?.defaultWorkspaceRootPath;
  const progressStore = createCodexTuiSessionStore({ workspaceRoot });
  const progressReadFn = progressStore;
  const readGoalProgress = (g) => progressStore.readGoalProgress(g);
  const readGoalSubagents = (g) => progressStore.readGoalSubagents(g);

  function sessionWorkspaceRoots() {
    return [config?.defaultRepoPath, config?.defaultWorkspaceRoot].filter(Boolean);
  }

  async function resolveGoalForTask(task, context) {
    const state = await store.load();
    const existing = task.goal_id
      ? state.goals?.find((goal) => goal.id === task.goal_id)
      : state.goals?.find((goal) => goal.task_id === task.id);
    if (existing?.id) return existing;
    const linked = await ensureTaskGoalFn(store, config, task.id, context, { assign_to_codex: true });
    return linked.goal || null;
  }

  /**
   * Start a Codex TUI session within an isolated task worktree.
   *
   * Flow:
   *   1. resolve plan (no git mutation)
   *   2. materialize worktree (git worktree add)
   *   3. verify task worktree is valid
   *   4. cwd = task_worktree_path
   *   5. acquire lock on worktree path
   *   6. create execution record
   *   7. start TUI session within worktree
   */
  async function startGoalHandler({ task_id }, context) {
    if (!isCodexTuiEnabled(config)) {
      return { kind: "codex_tui_disabled", status: "disabled", provider: "codex_tui_goal", reason: "TUI was explicitly disabled by GPTWORK_CODEX_TUI_ENABLED=false" };
    }

    const task = await findTaskFn(store, task_id);
    const existingOwner = task.metadata?.tui_session_owner;
    if (existingOwner) {
      const err = new Error(`${existingOwner} Codex TUI session already owns task ${task.id}`);
      err.code = "codex_tui_task_already_claimed";
      throw err;
    }
    const claimTransition = await transitionService.transitionTask({
      task_id: task.id,
      event: TASK_EVENTS.RECONCILIATION_CORRECTION,
      expected_statuses: [task.status],
      payload: { canonical_status: "running", audit: { operation: "manual_tui_claim" } },
      reason: "manual TUI session claimed task",
      source: "codex_tui",
      actor: { type: "operator", id: "codex_tui_start_goal" },
      idempotency_key: `tui_claim:${task.id}:${task.status}`,
    });
    await mutableStore.mutate((state) => {
      const item = (state.tasks || []).find((candidate) => candidate.id === task.id);
      if (!item) return;
      item.metadata = { ...(item.metadata || {}), codex_execution_provider: "codex_tui_goal", tui_session_owner: "manual", manual_tui_session_starting: true };
      item.logs ||= [];
      item.logs.push({ time: new Date().toISOString(), message: "[tui] manual session start claimed task" });
    });
    const claimedTask = claimTransition.task;
    const previousStatus = task.status;
    let claimSettled = false;
    try {
    const goal = await resolveGoalForTask(claimedTask, context);
    if (!goal?.id) {
      return { kind: "codex_tui_goal_missing", status: "blocked", task_id: task.id, reason: "Task has no resolvable goal_id" };
    }

    // task_pipeline_v2 must prepare bounded role views and advisory/formal
    // Agent Runs on every execution entry path, including manual TUI starts.
    if (claimedTask.pipeline_version === "task_pipeline_v2" || goal.task_context?.contract_digest) {
      await ensurePipelineRunsForTaskFn(
        store,
        { task_id: claimedTask.id, goal_id: goal.id },
        context,
      );
    }

    // Phase 1: resolve plan (no git mutation)
    const repoPlan = await resolveTaskRepositoryPlanFn({ task: claimedTask, goal, config, registry });
    if (!repoPlan) {
      return { kind: "codex_tui_plan_failed", status: "blocked", task_id: task.id, goal_id: goal.id, reason: "Repository plan resolution returned null" };
    }

    const canonicalRepoPath = repoPlan.canonical_repo_path || repoPlan.source_root;
    if (!canonicalRepoPath) {
      return { kind: "codex_tui_repo_missing", status: "blocked", task_id: task.id, goal_id: goal.id, reason: "No canonical repository path resolved" };
    }

    // Phase 2: materialize worktree (git worktree add)
    const materialized = await materializeTaskWorktreeFn(repoPlan, { config });
    if (!materialized?.worktree_lifecycle?.ok) {
      return {
        kind: "codex_tui_worktree_failed",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        error: materialized?.worktree_lifecycle?.error || "Worktree materialization failed",
        plan: repoPlan,
        materialized,
      };
    }

    const worktreePath = materialized.worktree_lifecycle.worktree_path || repoPlan.task_worktree_path;
    const branch = materialized.worktree_lifecycle.branch_name || repoPlan.task_branch;

    // Phase 3: verify task worktree is valid
    try {
      const gitCheck = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (gitCheck !== "true") {
        return {
          kind: "codex_tui_worktree_invalid",
          status: "blocked",
          task_id: task.id,
          goal_id: goal.id,
          worktree_path: worktreePath,
          error: "Path exists but is not a valid git worktree",
        };
      }
    } catch (err) {
      return {
        kind: "codex_tui_worktree_invalid",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        worktree_path: worktreePath,
        error: `Worktree verification failed: ${err.message}`,
      };
    }

    // Phase 4: cwd = task_worktree_path, check dirty status on worktree
    const statusLines = gitStatusShort(worktreePath);
    if (statusLines.length > 0) {
      return {
        kind: "codex_tui_dirty_worktree",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        cwd: worktreePath,
        dirty_paths: dirtyPaths(statusLines),
      };
    }

    // Phase 5: lock on worktree path
    const lockResult = await acquireRepoLockFn(workspaceRoot, worktreePath, {
      taskId: task.id,
      runId: null,
      mode: task.mode || goal.mode || "full",
    });
    if (!lockResult?.acquired) {
      return {
        kind: "codex_tui_worktree_locked",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        cwd: worktreePath,
        held_by_task: lockResult?.heldByTask || null,
        held_by_run_id: lockResult?.heldByRunId || null,
        reason: lockResult?.reason || "Worktree lock is held by another task",
      };
    }

    // Phase 6: create execution record
    let baseCommit = null;
    try {
      baseCommit = execFileSync("git", ["rev-parse", repoPlan.base_ref || "HEAD"], {
        cwd: canonicalRepoPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
    } catch {}

    const execStore = createExecutionStoreFn({ workspaceRoot: workspaceRoot || canonicalRepoPath });
    const execution = await execStore.createExecution({
      executionId: `exec_${task.id}`,
      workstreamId: task.workstream_id || goal.workstream_id || workstreamId || null,
      goalId: goal.id,
      taskId: task.id,
      worktreePath,
      branch,
      baseCommit,
      headCommit: null,
      sessionId: null,
      codexThreadId: null,
      metadata: {
        canonical_repo_path: canonicalRepoPath,
        task_title: task.title || null,
        provider: "codex_tui_goal",
        plan: repoPlan,
        task_context_digest: task.task_context_digest || goal.task_context?.contract_digest || null,
        task_context_revision: task.task_context_revision || goal.task_context?.revision || null,
        workstream_context_digest: task.workstream_context_digest || null,
        workstream_context_revision: task.workstream_context_revision || null,
      },
    });

    // Phase 7: start TUI session within worktree, cwd = task_worktree_path.
    // Startup is transactional: a PTY failure must not leave a held lock or
    // a half-created execution that appears to be running.
    let session;
    try {
      session = await startCodexTuiGoalSessionFn({
        task,
        goal,
        cwd: worktreePath,
        workspaceRoot: workspaceRoot || canonicalRepoPath,
        repoLockId: lockResult.lock?.safe_repo_id || null,
        workstreamId: task.workstream_id || goal.workstream_id || workstreamId || null,
        executionId: execution.id,
        worktreePath,
        branch,
        baseCommit,
        headCommit: baseCommit,
        taskContextDigest: task.task_context_digest || goal.task_context?.contract_digest || null,
        taskContextRevision: task.task_context_revision || goal.task_context?.revision || null,
        workstreamContextDigest: task.workstream_context_digest || null,
        workstreamContextRevision: task.workstream_context_revision || null,
        onTerminalized: async (terminalSession) => {
          const snapshot = await collectCodexTuiCompletionFn({
            sessionId: terminalSession.id,
            workspaceRoot: workspaceRoot || canonicalRepoPath,
          });
          const resultStatus = snapshot?.result_json?.status;
          const canonicalStatus = resultStatus === "completed" ? "waiting_for_review"
            : (resultStatus === "timed_out" ? "timed_out" : "failed");
          await transitionService.transitionTask({
            task_id: task.id,
            event: TASK_EVENTS.RECONCILIATION_CORRECTION,
            payload: {
              canonical_status: canonicalStatus,
              task_result_patch: {
                ...(snapshot?.result_json || {}),
                provider: "codex_tui_goal",
                session_id: terminalSession.id,
                result_json_present: snapshot?.result_json_present === true,
                result_json_valid: snapshot?.result_json_valid === true,
                worktree_clean: snapshot?.worktree_clean ?? null,
              },
              audit: { operation: "tui_terminal_auto_collect", session_id: terminalSession.id },
            },
            reason: `TUI terminal event auto-collected: ${resultStatus || terminalSession.status}`,
            source: "codex_tui",
            actor: { type: "system", id: "codex_tui_terminal_callback" },
            idempotency_key: `tui_terminal_collect:${task.id}:${terminalSession.id}:${resultStatus || terminalSession.status}`,
          });
          await execStore.updateExecution(execution.id, {
            status: canonicalStatus === "waiting_for_review" ? "completed" : canonicalStatus,
            evidence_ref: snapshot?.result_json_path || null,
          }).catch(() => {});
          await mutableStore.mutate((state) => {
            const item = (state.tasks || []).find((candidate) => candidate.id === task.id);
            if (!item) return;
            item.metadata = { ...(item.metadata || {}), tui_session_id: terminalSession.id };
            delete item.metadata.tui_session_owner;
            delete item.metadata.manual_tui_session_starting;
            item.logs ||= [];
            item.logs.push({ time: new Date().toISOString(), message: `[tui] terminal auto-collect: ${canonicalStatus}` });
          }).catch(() => {});
        },
      });
    } catch (err) {
      await execStore.updateExecution(execution.id, {
        status: "failed",
        error: err?.message || String(err),
        error_code: err?.code || null,
        finished_at: new Date().toISOString(),
      }).catch(() => {});
      await releaseRepoLockFn(workspaceRoot, worktreePath, claimedTask.id).catch(() => {});
      await transitionService.transitionTask({
        task_id: claimedTask.id,
        event: TASK_EVENTS.RECONCILIATION_CORRECTION,
        payload: {
          canonical_status: "failed",
          task_result_patch: { provider: "codex_tui_goal", start_error: err?.message || String(err) },
          audit: { operation: "manual_tui_start_failed" },
        },
        reason: `TUI start failed: ${err?.message || String(err)}`,
        source: "codex_tui",
        actor: { type: "system", id: "codex_tui_start_goal" },
        idempotency_key: `tui_start_failed:${claimedTask.id}:${execution.id}`,
      }).catch(() => {});
      await mutableStore.mutate((state) => {
        const item = (state.tasks || []).find((candidate) => candidate.id === claimedTask.id);
        if (item) item.metadata = { ...(item.metadata || {}), manual_tui_session_starting: false };
      }).catch(() => {});
      claimSettled = true;
      return {
        kind: "codex_tui_start_failed",
        status: "failed",
        provider: "codex_tui_goal",
        task_id: task.id,
        goal_id: goal.id,
        execution_id: execution.id,
        cwd: worktreePath,
        error: err?.message || String(err),
        error_code: err?.code || null,
      };
    }

    // Update execution with session info
    if (session?.id) {
      await execStore.updateExecution(execution.id, {
        status: "running",
        session_id: session.id,
      }).catch(() => {});
    }

    await mutableStore.mutate((state) => {
      const item = (state.tasks || []).find((candidate) => candidate.id === claimedTask.id);
      if (!item) return;
      item.metadata = { ...(item.metadata || {}), codex_execution_provider: "codex_tui_goal", tui_session_owner: "manual", manual_tui_session_starting: false, tui_session_id: session.id };
      item.result = { ...(item.result || {}), provider: "codex_tui_goal", session_id: session.id, cwd: worktreePath };
    });
    claimSettled = true;

    return {
      kind: "codex_tui_session_started",
      session_id: session.id,
      task_id: task.id,
      goal_id: goal.id,
      cwd: worktreePath,
      worktree_path: worktreePath,
      canonical_repo_path: canonicalRepoPath,
      branch,
      execution_id: execution.id,
      status: session.status,
    };
    } finally {
      if (!claimSettled) {
        await transitionService.transitionTask({
          task_id: claimedTask.id,
          event: TASK_EVENTS.RECONCILIATION_CORRECTION,
          payload: { canonical_status: previousStatus, audit: { operation: "manual_tui_claim_rollback" } },
          reason: "manual TUI claim released before startup completed",
          source: "codex_tui",
          actor: { type: "system", id: "codex_tui_start_goal" },
          idempotency_key: `tui_claim_rollback:${claimedTask.id}:${previousStatus}`,
        }).catch(() => {});
        await mutableStore.mutate((state) => {
          const item = (state.tasks || []).find((candidate) => candidate.id === claimedTask.id);
          if (!item) return;
          item.metadata = { ...(item.metadata || {}) };
          delete item.metadata.tui_session_owner;
          delete item.metadata.manual_tui_session_starting;
          delete item.metadata.tui_session_id;
          item.logs ||= [];
          item.logs.push({ time: new Date().toISOString(), message: "[tui] manual session claim released before startup completed" });
        }).catch(() => {});
      }
    }
  }

  return {
    codex_tui_start_goal: tool({
      name: "codex_tui_start_goal",
      description: "Start a manual Codex TUI goal session for an existing task using an isolated git worktree.",
      inputSchema: schema({ task_id: { type: "string", description: "Task ID to run through the Codex TUI provider." } }, ["task_id"]),
      ...metadata,
      handler: startGoalHandler,
    }),
    codex_tui_status: tool({
      name: "codex_tui_status",
      description: "Read status for an active or recorded Codex TUI session.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => getCodexTuiSessionStatusFn(session_id, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    codex_tui_read: tool({
      name: "codex_tui_read",
      description: "Read durable log output for a Codex TUI session.",
      inputSchema: schema({ session_id: "string", max_chars: "integer" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id, max_chars }) => readCodexTuiSessionFn(session_id, { maxChars: max_chars, candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    codex_tui_send: tool({
      name: "codex_tui_send",
      description: "Send text input to an active Codex TUI session.",
      inputSchema: schema({ session_id: "string", text: "string" }, ["session_id", "text"]),
      ...metadata,
      handler: async ({ session_id, text }) => {
        const input = String(text ?? "");
        if (input.trim().startsWith("/")) {
          return sendCodexTuiSlashCommandFn(session_id, input, { candidateWorkspaceRoots: sessionWorkspaceRoots() });
        }
        return sendCodexTuiSessionInputFn(session_id, input, { candidateWorkspaceRoots: sessionWorkspaceRoots() });
      },
    }),
    codex_tui_preview_task_delta: tool({
      name: "codex_tui_preview_task_delta",
      description: "Validate and preview a structured same-task TUI delta without sending it.",
      inputSchema: schema({ session_id: "string", delta: "object" }, ["session_id", "delta"]),
      ...metadata,
      handler: async ({ session_id, delta }) => {
        const session = await readCodexTuiSessionFn(session_id, { maxChars: 0, candidateWorkspaceRoots: sessionWorkspaceRoots() });
        validateTaskDelta(delta, session);
        return { valid: true, session_id, revision: delta.revision, instruction: renderDeltaInstruction(delta) };
      },
    }),
    codex_tui_send_task_delta: tool({
      name: "codex_tui_send_task_delta",
      description: "Persist and send a validated structured delta to the active TUI session for the same Task.",
      inputSchema: schema({ session_id: "string", delta: "object" }, ["session_id", "delta"]),
      ...metadata,
      handler: async ({ session_id, delta }) => sendCodexTuiTaskDeltaFn(session_id, delta, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    codex_tui_stop: tool({
      name: "codex_tui_stop",
      description: "Stop an active Codex TUI session and release its worktree lock.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => {
        let before = null;
        try { before = await readCodexTuiSessionFn(session_id, { maxChars: 0, candidateWorkspaceRoots: sessionWorkspaceRoots() }); } catch {}
        const stopped = await stopCodexTuiSessionFn(session_id, { reason: "manual_stop", candidateWorkspaceRoots: sessionWorkspaceRoots() });
        if (before?.cwd && before?.task_id) {
          try { await releaseRepoLockFn(workspaceRoot, before.cwd, before.task_id); } catch {}
          const hasEvidence = Boolean(before?.result_json || before?.result?.result_json || before?.completion?.ready_for_review);
          const task = await reconcileStoppedTuiTask({ store, taskId: before.task_id, reason: "manual_stop", hasEvidence });
          return { ...stopped, task_state: task?.status || null, reconciled: Boolean(task) };
        }
        return stopped;
      },
    }),
codex_tui_collect: tool({
      name: "codex_tui_collect",
      description: "Collect durable completion evidence for a Codex TUI session without reading TUI screen text.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => {
        const snapshot = await collectCodexTuiCompletionFn({ sessionId: session_id, workspaceRoot });
        if (snapshot.task_id && snapshot.goal_id) {
          snapshot.agent_run_reconciliation = await reconcileTuiAgentRunsFn({
            store,
            workspaceRoot,
            snapshot,
          }).catch((error) => ({ reconciled: false, reason: error?.message || String(error), error: true }));
        }

        const terminalFailureStatus = ["failed", "timed_out", "stopped", "cancelled", "detached"].includes(snapshot.result_json?.status)
          ? snapshot.result_json.status
          : null;
        if (terminalFailureStatus && snapshot.task_id) {
          try {
            const state = await store.load();
            const currentTask = (state.tasks || []).find((item) => item.id === snapshot.task_id);
            if (currentTask && !isTerminalStatus(currentTask.status)) {
              snapshot.terminal_writeback = await persistTuiTerminalState({
                store: mutableStore,
                task: currentTask,
                taskResult: {
                  ...(snapshot.result_json || snapshot.reconstructed_result || {}),
                  provider: "codex_tui_goal",
                  session_id: snapshot.session_id,
                  result_json_present: snapshot.result_json_present === true,
                  result_json_valid: snapshot.result_json_valid === true,
                  worktree_clean: snapshot.worktree_clean ?? null,
                  findings: snapshot.findings || [],
                  status: terminalFailureStatus,
                },
                unifiedDecision: {
                  status: terminalFailureStatus,
                  blocking_passed: false,
                  completion_eligible: false,
                  requires_review: false,
                  safe_to_auto_advance: false,
                  source: "codex_tui_collect_terminal_failure",
                  normalized_at: new Date().toISOString(),
                  goal_effect: { status: terminalFailureStatus, complete_goal: false, safe_to_auto_advance: false },
                  queue_effect: { status: terminalFailureStatus, unblock_dependents: false },
                },
                workspaceRoot,
              });
            }
          } catch (error) {
            snapshot.terminal_writeback = { persisted: false, error: error?.message || String(error) };
          }
        }

        // When the session evidence is complete and ready for review,
        // write the result back to the task and transition its status.
        // This is the single boundary where TUI completion evidence becomes
        // durable task state. Do NOT transition when snapshot has blockers.
        if (snapshot.ready_for_review && snapshot.task_id) {
          try {
            const state = await store.load();
            const currentTask = (state.tasks || []).find((item) => item.id === snapshot.task_id);
            if (currentTask && ['running', 'assigned', 'collecting', 'waiting_for_review', 'waiting_for_supervisor', 'completed'].includes(currentTask.status)) {
              const currentResult = currentTask.result || {};
              const goal = (state.goals || []).find((item) => item.id === snapshot.goal_id) || {};
              const rawResult = {
                ...(snapshot.result_json || snapshot.reconstructed_result || {}),
                commit: snapshot.commit,
                tests: snapshot.tests,
                changed_files: snapshot.changed_files || [],
                worktree_clean: snapshot.worktree_clean,
              };
              const acceptanceContract = goal.acceptance_contract || currentTask.acceptance_contract || null;
              const contractVerification = verifyAcceptanceContract({
                contract: acceptanceContract,
                task: currentTask,
                goal,
                result: rawResult,
                verification: rawResult.verification || {},
              });
              const resultPatch = {
                ...rawResult,
                provider: 'codex_tui_goal',
                session_id: snapshot.session_id,
                commit: snapshot.commit,
                tests: snapshot.tests,
                changed_files: snapshot.changed_files || [],
                verification: {
                  ...(snapshot.result_json?.verification || {}),
                  passed: diagnosticVerificationPassed(snapshot.result_json),
                  commands: Array.isArray(snapshot.result_json?.verification?.commands)
                    ? snapshot.result_json.verification.commands
                    : [],
                  reports: snapshot.result_json?.verification?.reports
                    || snapshot.result_json?.tests?.details
                    || [],
                },
                worktree_clean: snapshot.worktree_clean,
                repo_mutated: snapshot.requires_commit === false
                  && snapshot.worktree_clean === true
                  && (snapshot.changed_files || []).length === 0
                    ? false
                    : (snapshot.result_json?.repo_mutated ?? currentResult.repo_mutated ?? null),
                diagnostic_evidence: snapshot.requires_commit === false
                  ? {
                      ...(currentResult.diagnostic_evidence || {}),
                      ...(snapshot.result_json?.diagnostic_evidence || {}),
                      summary: snapshot.result_json?.diagnostic_evidence?.summary
                        || snapshot.result_json?.summary
                        || currentResult.diagnostic_evidence?.summary
                        || null,
                      report_path: snapshot.result_json_path || null,
                      repo_mutated: snapshot.worktree_clean === true
                        && (snapshot.changed_files || []).length === 0
                          ? false
                          : (snapshot.result_json?.diagnostic_evidence?.repo_mutated ?? null),
                    }
                  : (snapshot.result_json?.diagnostic_evidence || currentResult.diagnostic_evidence || null),
                result_md_present: snapshot.result_md_present,
                result_json_present: snapshot.result_json_present,
                contract_verification: contractVerification,
              };
              const canComplete = contractVerification.completion_eligible === true
                && contractVerification.blocking_passed === true
                && acceptanceContract?.requirements?.requires_integration !== true;
              const canonicalStatus = canComplete ? 'completed' : 'waiting_for_review';
              if (canComplete) {
                await persistTuiTerminalState({
                  store: mutableStore,
                  task: currentTask,
                  taskResult: { ...resultPatch, status: 'completed' },
                  unifiedDecision: {
                    status: 'completed',
                    blocking_passed: true,
                    completion_eligible: true,
                    requires_review: false,
                    safe_to_auto_advance: true,
                    source: 'codex_tui_collect',
                    profile: acceptanceContract?.profile || acceptanceContract?.intent?.operation_kind || null,
                    normalized_at: new Date().toISOString(),
                    goal_effect: { status: 'completed', complete_goal: true, safe_to_auto_advance: true },
                    queue_effect: { status: 'completed', unblock_dependents: true },
                  },
                  workspaceRoot,
                });
                await mutableStore.mutate((nextState) => {
                  const now = new Date().toISOString();
                  for (const run of nextState.agent_runs || []) {
                    if (run.task_id !== snapshot.task_id || !['builder', 'verifier', 'reviewer', 'finalizer'].includes(run.role)) continue;
                    run.status = 'completed';
                    run.summary = `${run.role}: completed from accepted TUI evidence`;
                    run.output_artifacts = [{
                      kind: run.role === 'verifier' ? 'verification' : run.role === 'reviewer' ? 'reviewer_decision' : run.role === 'finalizer' ? 'result' : 'change_summary',
                      path: snapshot.result_json_path,
                      passed: run.role === 'verifier' || run.role === 'reviewer' ? true : undefined,
                      status: 'completed',
                      commit: snapshot.commit,
                      changed_count: snapshot.changed_files?.length || 0,
                      metadata: { source: 'accepted_tui_evidence', context_digest: run.input_context_digest || null },
                    }];
                    run.events = Array.isArray(run.events) ? run.events : [];
                    run.events.push({ type: 'completed', message: run.summary, data: { status: 'completed', source: 'accepted_tui_evidence' }, created_at: now });
                    run.updated_at = now;
                  }
                });
              } else {
                await transitionService.transitionTask({
                  task_id: snapshot.task_id,
                  event: TASK_EVENTS.RECONCILIATION_CORRECTION,
                  expected_statuses: [currentTask.status],
                  payload: {
                    canonical_status: canonicalStatus,
                    task_result_patch: resultPatch,
                    audit: { operation: 'tui_collect_evidence_writeback', session_id: snapshot.session_id },
                  },
                  reason: 'TUI collect produced reviewable evidence',
                  source: 'codex_tui',
                  actor: { type: 'system', id: 'codex_tui_collect' },
                  idempotency_key: `tui_collect:${snapshot.task_id}:${snapshot.session_id}:${snapshot.commit || 'no_commit'}`,
                });
              }
              await mutableStore.mutate((nextState) => {
                const item = (nextState.tasks || []).find((candidate) => candidate.id === snapshot.task_id);
                if (!item) return;
                item.metadata = { ...(item.metadata || {}), tui_session_id: snapshot.session_id };
                delete item.metadata.tui_session_owner;
                item.logs ||= [];
                item.logs.push({ time: new Date().toISOString(), message: `[tui] collect: complete evidence, transitioned to ${canonicalStatus}` });
              });
            }
          } catch (err) {
            snapshot.writeback_error = err?.message || String(err);
            snapshot.writeback_failed = true;
          }
        }
        return snapshot;
      },
    }),

    // -- Structured subagent progress tools (no ANSI parsing) ----------------

    codex_tui_progress: tool({
      name: "codex_tui_progress",
      description: "Read structured subagent pipeline progress for a goal without parsing ANSI TUI screen output. Returns phase, status, current_action, blockers, next_expected_event, last_progress_at, and subagent states.",
      inputSchema: schema({ goal_id: "string" }, ["goal_id"]),
      ...metadata,
      handler: async ({ goal_id }) => {
        const progress = await readGoalProgress(goal_id);
        if (!progress) {
          return {
            kind: "no_progress",
            goal_id,
            status: "no_data",
            detail: "No progress.json found for this goal. The goal may not have started execution yet.",
          };
        }
        const state = await store.load();
        const goal = (state.goals || []).find((item) => item.id === goal_id);
        const task = (state.tasks || []).find((item) =>
          item.goal_id === goal_id || (goal?.task_id && item.id === goal.task_id)
        );
        if (task && isTerminalStatus(task.status)) {
          return {
            kind: "subagent_progress",
            goal_id,
            ...progress,
            phase: "terminal",
            status: task.status,
            current_action: "none",
            next_expected_event: null,
            stale_progress_overridden: progress.status !== task.status || progress.phase !== "terminal",
            terminal_task_id: task.id,
          };
        }
        return {
          kind: "subagent_progress",
          goal_id,
          ...progress,
        };
      },
    }),
    codex_tui_subagents: tool({
      name: "codex_tui_subagents",
      description: "Read structured subagent results for a goal without parsing ANSI TUI screen output. Returns an array of subagent results with role, status, summary, changed_files, artifacts, blockers, and timestamps.",
      inputSchema: schema({ goal_id: "string" }, ["goal_id"]),
      ...metadata,
      handler: async ({ goal_id }) => {
        const subagents = await readGoalSubagents(goal_id);
        if (!subagents || !Array.isArray(subagents) || subagents.length === 0) {
          return {
            kind: "no_subagents",
            goal_id,
            subagents: [],
            count: 0,
          };
        }
        return {
          kind: "subagent_results",
          goal_id,
          subagents,
          count: subagents.length,
        };
      },
    }),
  };
}
