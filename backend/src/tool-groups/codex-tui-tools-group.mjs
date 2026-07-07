import { execFileSync } from "node:child_process";
import { acquireRepoLock, releaseRepoLock } from "../repo-lock.mjs";
import { findTask } from "../task-lifecycle.mjs";
import { ensureTaskGoal } from "../goal-task-lifecycle.mjs";
import { resolveTaskRepositoryPlan } from "../task-repo-resolution.mjs";
import { isCodexTuiEnabled } from "../codex-execution-provider.mjs";
import {
  getCodexTuiSessionStatus,
  readCodexTuiSession,
  sendCodexTuiSessionInput,
  startCodexTuiGoalSession,
  stopCodexTuiSession,
} from "../codex-tui-session-manager.mjs";
import { collectCodexTuiCompletion } from "../codex-tui-completion-collector.mjs";

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
  acquireRepoLockFn = acquireRepoLock,
  releaseRepoLockFn = releaseRepoLock,
  startCodexTuiGoalSessionFn = startCodexTuiGoalSession,
  getCodexTuiSessionStatusFn = getCodexTuiSessionStatus,
  readCodexTuiSessionFn = readCodexTuiSession,
  sendCodexTuiSessionInputFn = sendCodexTuiSessionInput,
  stopCodexTuiSessionFn = stopCodexTuiSession,
  collectCodexTuiCompletionFn = collectCodexTuiCompletion,
} = {}) {
  const metadata = tuiToolMetadata();

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

  async function startGoalHandler({ task_id }, context) {
    if (!isCodexTuiEnabled(config)) {
      return { kind: "codex_tui_disabled", status: "disabled", provider: "codex_tui_goal", reason: "GPTWORK_CODEX_TUI_ENABLED is not true" };
    }

    const task = await findTaskFn(store, task_id);
    const goal = await resolveGoalForTask(task, context);
    if (!goal?.id) {
      return { kind: "codex_tui_goal_missing", status: "blocked", task_id: task.id, reason: "Task has no resolvable goal_id" };
    }

    const repoPlan = await resolveTaskRepositoryPlanFn({ task, goal, config, registry });
    const cwd = repoPlan?.canonical_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot;
    if (!cwd) {
      return { kind: "codex_tui_repo_missing", status: "blocked", task_id: task.id, goal_id: goal.id, reason: "No canonical repository path resolved" };
    }

    const statusLines = gitStatusShort(cwd);
    if (statusLines.length > 0) {
      return {
        kind: "codex_tui_dirty_worktree",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        cwd,
        dirty_paths: dirtyPaths(statusLines),
      };
    }

    const lockResult = await acquireRepoLockFn(config.defaultWorkspaceRoot, cwd, {
      taskId: task.id,
      runId: null,
      mode: task.mode || goal.mode || "builder",
    });
    if (!lockResult?.acquired) {
      return {
        kind: "codex_tui_repo_locked",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        cwd,
        held_by_task: lockResult?.heldByTask || null,
        held_by_run_id: lockResult?.heldByRunId || null,
        reason: lockResult?.reason || "Repo lock is held by another task",
      };
    }

    const session = await startCodexTuiGoalSessionFn({
      task,
      goal,
      cwd,
      repoLockId: lockResult.lock?.safe_repo_id || null,
    });

    return {
      kind: "codex_tui_session_started",
      session_id: session.id,
      task_id: task.id,
      goal_id: goal.id,
      cwd: session.cwd || cwd,
      status: session.status,
    };
  }

  return {
    codex_tui_start_goal: tool({
      name: "codex_tui_start_goal",
      description: "Start a manual Codex TUI goal session for an existing task.",
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
      description: "Stop an active Codex TUI session.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => {
        let before = null;
        try { before = await readCodexTuiSessionFn(session_id, { maxChars: 0, candidateWorkspaceRoots: sessionWorkspaceRoots() }); } catch {}
        const stopped = await stopCodexTuiSessionFn(session_id, { reason: "manual_stop", candidateWorkspaceRoots: sessionWorkspaceRoots() });
        if (before?.cwd && before?.task_id) {
          try { await releaseRepoLockFn(config.defaultWorkspaceRoot, before.cwd, before.task_id); } catch {}
        }
        return stopped;
      },
    }),
    codex_tui_collect: tool({
      name: "codex_tui_collect",
      description: "Collect durable completion evidence for a Codex TUI session without reading TUI screen text.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => collectCodexTuiCompletionFn({ sessionId: session_id, workspaceRoot: config.defaultWorkspaceRoot }),
    }),
  };
}
