import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function rmPath(path) {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listNames(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Delete durable on-disk artifacts for intentionally deleted tasks/goals.
 * This is best-effort and never fails the state deletion itself.
 */
export async function cleanupDeletedTaskArtifacts({
  workspaceRoot,
  projectRoot = null,
  taskIds = [],
  goalIds = [],
} = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const tasks = [...new Set((taskIds || []).filter(Boolean))];
  const goals = [...new Set((goalIds || []).filter(Boolean))];
  const deleted = {
    goals: [],
    context_index: [],
    runs: [],
    views: [],
    sessions: [],
    worktrees: [],
    locks: [],
  };

  for (const goalId of goals) {
    const goalDir = join(workspaceRoot, ".gptwork", "goals", goalId);
    if (await rmPath(goalDir)) deleted.goals.push(goalDir);
    const indexDir = join(workspaceRoot, ".gptwork", "context-index", goalId);
    if (await rmPath(indexDir)) deleted.context_index.push(indexDir);
  }

  for (const taskId of tasks) {
    const runDir = join(workspaceRoot, ".gptwork", "runs", taskId);
    if (await rmPath(runDir)) deleted.runs.push(runDir);

    // views/goals/*--gXXXX/tasks/*--tYYYY
    const viewsRoot = join(workspaceRoot, ".gptwork", "views", "goals");
    for (const entry of await listNames(viewsRoot)) {
      if (!entry.isDirectory()) continue;
      const viewGoalDir = join(viewsRoot, entry.name);
      // remove whole goal view if goal id suffix matches any deleted goal
      if (goals.some((goalId) => entry.name.endsWith(goalId.slice(0, 8)) || entry.name.includes(goalId))) {
        if (await rmPath(viewGoalDir)) deleted.views.push(viewGoalDir);
        continue;
      }
      const tasksDir = join(viewGoalDir, "tasks");
      for (const taskEntry of await listNames(tasksDir)) {
        if (!taskEntry.isDirectory()) continue;
        if (taskEntry.name.includes(taskId) || taskEntry.name.endsWith(taskId.slice(0, 8))) {
          const p = join(tasksDir, taskEntry.name);
          if (await rmPath(p)) deleted.views.push(p);
        }
      }
    }

    // session control records/logs
    const sessionDir = join(workspaceRoot, ".gptwork", "codex-tui-sessions");
    for (const entry of await listNames(sessionDir)) {
      if (!entry.isFile()) continue;
      if (entry.name.includes(taskId) || goals.some((goalId) => entry.name.includes(goalId))) {
        const p = join(sessionDir, entry.name);
        if (await rmPath(p)) deleted.sessions.push(p);
      }
    }

    // worktrees by task id
    const worktreeRoot = join(workspaceRoot, ".gptwork", "worktrees");
    for (const repo of await listNames(worktreeRoot)) {
      if (!repo.isDirectory()) continue;
      const p = join(worktreeRoot, repo.name, taskId);
      if (await rmPath(p)) deleted.worktrees.push(p);
    }

    // locks mentioning task id
    const lockRoot = join(workspaceRoot, ".gptwork", "locks", "repos");
    for (const entry of await listNames(lockRoot)) {
      if (!entry.isFile()) continue;
      if (entry.name.includes(taskId)) {
        const p = join(lockRoot, entry.name);
        if (await rmPath(p)) deleted.locks.push(p);
      }
    }
  }

  // project-root mirror goals if different
  if (projectRoot && projectRoot !== workspaceRoot) {
    for (const goalId of goals) {
      const goalDir = join(projectRoot, ".gptwork", "goals", goalId);
      if (await rmPath(goalDir)) deleted.goals.push(goalDir);
    }
  }

  return deleted;
}
