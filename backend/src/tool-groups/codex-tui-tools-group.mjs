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
import { findTask } from "../task-lifecycle.mjs";
import { ensureTaskGoal } from "../goal-task-lifecycle.mjs";
import { resolveTaskRepositoryPlan, materializeTaskWorktree } from "../task-repo-resolution.mjs";
import { isCodexTuiEnabled } from "../codex-execution-provider.mjs";
import { createExecutionStore } from "../executions/execution-store.mjs";
import {
  getCodexTuiSessionStatus,
  readCodexTuiSession,
  sendCodexTuiSessionInput,
  startCodexTuiGoalSession,
  stopCodexTuiSession,
} from "../codex-tui-session-manager.mjs";
import { collectCodexTuiCompletion } from "../codex-tui-completion-collector.mjs";
import { createCodexTuiSessionStore } from "../codex-tui-session-store.mjs";

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
  stopCodexTuiSessionFn = stopCodexTuiSession,
  collectCodexTuiCompletionFn = collectCodexTuiCompletion,
  createExecutionStoreFn = createExecutionStore,
  workstreamId = null,
} = {}) {
  const metadata = tuiToolMetadata();
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
      return { kind: "codex_tui_disabled", status: "disabled", provider: "codex_tui_goal", reason: "GPTWORK_CODEX_TUI_ENABLED is not true" };
    }

    const task = await findTaskFn(store, task_id);
    const goal = await resolveGoalForTask(task, context);
    if (!goal?.id) {
      return { kind: "codex_tui_goal_missing", status: "blocked", task_id: task.id, reason: "Task has no resolvable goal_id" };
    }

    // Phase 1: resolve plan (no git mutation)
    const repoPlan = await resolveTaskRepositoryPlanFn({ task, goal, config, registry });
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
      mode: task.mode || goal.mode || "builder",
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
      workstreamId,
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
      },
    });

    // Phase 7: start TUI session within worktree, cwd = task_worktree_path
    const session = await startCodexTuiGoalSessionFn({
      task,
      goal,
      cwd: worktreePath,
      workspaceRoot: workspaceRoot || canonicalRepoPath,
      repoLockId: lockResult.lock?.safe_repo_id || null,
    });

    // Update execution with session info
    if (session?.id) {
      await execStore.updateExecution(execution.id, {
        status: "running",
        session_id: session.id,
      }).catch(() => {});
    }

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
      handler: async ({ session_id, text }) => sendCodexTuiSessionInputFn(session_id, text, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
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
        }
        return stopped;
      },
    }),
codex_tui_collect: tool({
      name: "codex_tui_collect",
      description: "Collect durable completion evidence for a Codex TUI session without reading TUI screen text.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => collectCodexTuiCompletionFn({ sessionId: session_id, workspaceRoot }),
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
