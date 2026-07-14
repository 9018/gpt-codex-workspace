/**
 * claude-tui-tools-group.mjs — Claude Code TUI goal MCP tools.
 *
 * Provides the same MCP tool surface as codex_tui_* but for Claude Code:
 *   claude_tui_start_goal, claude_tui_status, claude_tui_read,
 *   claude_tui_send, claude_tui_stop, claude_tui_resume, claude_tui_collect
 *
 * Uses the shared session store and completion collector so that tools
 * from both providers can inspect the same sessions. Existing codex_tui_*
 * tools are not affected.
 */

import { execFileSync } from "node:child_process";
import { acquireRepoLock, releaseRepoLock } from "../repo-lock.mjs";
import { findTask } from "../task-lifecycle.mjs";
import { ensureTaskGoal } from "../goal-task-lifecycle.mjs";
import { resolveTaskRepositoryPlan } from "../task-repo-resolution.mjs";
import { isClaudeTuiEnabled } from "../codex-execution-provider.mjs";
import {
  getClaudeTuiSessionStatus,
  readClaudeTuiSession,
  resumeClaudeTuiSession,
  sendClaudeTuiSessionInput,
  startClaudeTuiGoalSession,
  stopClaudeTuiSession,
} from "../claude-tui-session-manager.mjs";
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
    tags: ["claude", "tui"],
  };
}

/**
 * Create the Claude Code TUI tools group.
 *
 * @param {object} options - Dependency injection bag (same shape as codex-tui-tools-group)
 * @returns {object} Tools group with claude_tui_* tools
 */
export function createClaudeTuiToolsGroup({
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
  startGoalSessionFn = startClaudeTuiGoalSession,
  getSessionStatusFn = getClaudeTuiSessionStatus,
  readSessionFn = readClaudeTuiSession,
  resumeSessionFn = resumeClaudeTuiSession,
  sendSessionInputFn = sendClaudeTuiSessionInput,
  stopSessionFn = stopClaudeTuiSession,
  collectCompletionFn = collectCodexTuiCompletion,
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
    if (!isClaudeTuiEnabled(config)) {
      return {
        kind: "claude_tui_disabled",
        status: "disabled",
        provider: "claude_tui_goal",
        reason: "GPTWORK_CLAUDE_TUI_ENABLED is not true",
      };
    }

    const task = await findTaskFn(store, task_id);
    const goal = await resolveGoalForTask(task, context);
    if (!goal?.id) {
      return {
        kind: "claude_tui_goal_missing",
        status: "blocked",
        task_id: task.id,
        reason: "Task has no resolvable goal_id",
      };
    }

    const repoPlan = await resolveTaskRepositoryPlanFn({ task, goal, config, registry });
    const cwd = repoPlan?.canonical_repo_path || config.defaultRepoPath || config.defaultWorkspaceRoot;
    if (!cwd) {
      return {
        kind: "claude_tui_repo_missing",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        reason: "No canonical repository path resolved",
      };
    }

    const statusLines = gitStatusShort(cwd);
    if (statusLines.length > 0) {
      return {
        kind: "claude_tui_dirty_worktree",
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
      mode: task.mode || goal.mode || "full",
    });
    if (!lockResult?.acquired) {
      return {
        kind: "claude_tui_repo_locked",
        status: "blocked",
        task_id: task.id,
        goal_id: goal.id,
        cwd,
        held_by_task: lockResult?.heldByTask || null,
        held_by_run_id: lockResult?.heldByRunId || null,
        reason: lockResult?.reason || "Repo lock is held by another task",
      };
    }

    const session = await startGoalSessionFn({
      task,
      goal,
      cwd,
      repoLockId: lockResult.lock?.safe_repo_id || null,
    });

    return {
      kind: "claude_tui_session_started",
      session_id: session.id,
      task_id: task.id,
      goal_id: goal.id,
      cwd: session.cwd || cwd,
      status: session.status,
    };
  }

  return {
    claude_tui_start_goal: tool({
      name: "claude_tui_start_goal",
      description: "Start a manual Claude Code TUI goal session for an existing task.",
      inputSchema: schema(
        { task_id: { type: "string", description: "Task ID to run through the Claude TUI provider." } },
        ["task_id"]
      ),
      ...metadata,
      handler: startGoalHandler,
    }),
    claude_tui_status: tool({
      name: "claude_tui_status",
      description: "Read status for an active or recorded Claude TUI session.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) =>
        getSessionStatusFn(session_id, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    claude_tui_read: tool({
      name: "claude_tui_read",
      description: "Read durable log output for a Claude TUI session.",
      inputSchema: schema({ session_id: "string", max_chars: "integer" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id, max_chars }) =>
        readSessionFn(session_id, { maxChars: max_chars, candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    claude_tui_resume: tool({
      name: "claude_tui_resume",
      description: "Resume a recorded Claude TUI session by starting a fresh PTY and re-sending the goal contract.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) =>
        resumeSessionFn(session_id, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    claude_tui_send: tool({
      name: "claude_tui_send",
      description: "Send text input to an active Claude TUI session.",
      inputSchema: schema({ session_id: "string", text: "string" }, ["session_id", "text"]),
      ...metadata,
      handler: async ({ session_id, text }) =>
        sendSessionInputFn(session_id, text, { candidateWorkspaceRoots: sessionWorkspaceRoots() }),
    }),
    claude_tui_stop: tool({
      name: "claude_tui_stop",
      description: "Stop an active Claude TUI session.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) => {
        let before = null;
        try {
          before = await readSessionFn(session_id, { maxChars: 0, candidateWorkspaceRoots: sessionWorkspaceRoots() });
        } catch {}
        const stopped = await stopSessionFn(session_id, { reason: "manual_stop", candidateWorkspaceRoots: sessionWorkspaceRoots() });
        if (before?.cwd && before?.task_id) {
          try {
            await releaseRepoLockFn(config.defaultWorkspaceRoot, before.cwd, before.task_id);
          } catch {}
        }
        return stopped;
      },
    }),
    claude_tui_collect: tool({
      name: "claude_tui_collect",
      description: "Collect durable completion evidence for a Claude TUI session without reading TUI screen text.",
      inputSchema: schema({ session_id: "string" }, ["session_id"]),
      ...metadata,
      handler: async ({ session_id }) =>
        collectCompletionFn({ sessionId: session_id, workspaceRoot: config.defaultWorkspaceRoot }),
    }),
  };
}
