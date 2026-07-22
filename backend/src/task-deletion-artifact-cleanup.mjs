import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function rmPath(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      // Directory may still be written by a late TUI/result flush; retry briefly.
      if (error?.code === "ENOTEMPTY" || error?.code === "EBUSY") {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  // Final best-effort pass: empty children then remove.
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      await rm(join(path, entry.name), { recursive: true, force: true });
    }
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

function goalViewTokens(goalId) {
  const id = String(goalId || "");
  const tokens = new Set([id]);
  const m = id.match(/^goal_([a-f0-9]{8})/i);
  if (m) {
    tokens.add(`g${m[1].toLowerCase()}`);
    tokens.add(m[1].toLowerCase());
  }
  // also support unprefixed full uuid fragment
  const uuid = id.replace(/^goal_/, "");
  if (uuid) tokens.add(uuid.slice(0, 8).toLowerCase());
  return [...tokens];
}

function taskViewTokens(taskId) {
  const id = String(taskId || "");
  const tokens = new Set([id]);
  const m = id.match(/^task_([a-f0-9]{8})/i);
  if (m) {
    tokens.add(`t${m[1].toLowerCase()}`);
    tokens.add(m[1].toLowerCase());
  }
  const uuid = id.replace(/^task_/, "");
  if (uuid) tokens.add(uuid.slice(0, 8).toLowerCase());
  return [...tokens];
}

function nameMatchesAny(name, tokens) {
  const lower = String(name || "").toLowerCase();
  return tokens.some((token) => {
    const t = String(token || "").toLowerCase();
    if (!t) return false;
    return lower.includes(t) || lower.endsWith(`--${t}`) || lower.endsWith(`-${t}`);
  });
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
  markerNames = [],
} = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const tasks = [...new Set((taskIds || []).filter(Boolean))];
  const goals = [...new Set((goalIds || []).filter(Boolean))];
  const markers = [...new Set((markerNames || []).filter(Boolean).map((item) => String(item)))];
  const deleted = {
    goals: [],
    context_index: [],
    runs: [],
    views: [],
    sessions: [],
    worktrees: [],
    locks: [],
    markers: [],
  };

  const goalTokens = goals.flatMap(goalViewTokens);
  const taskTokens = tasks.flatMap(taskViewTokens);
  const titleTokens = [...new Set([
    ...markers,
    ...tasks,
    ...goals,
  ].map((item) => String(item || "").toLowerCase()).filter(Boolean))];

  for (const goalId of goals) {
    const goalDir = join(workspaceRoot, ".gptwork", "goals", goalId);
    if (await rmPath(goalDir)) deleted.goals.push(goalDir);
    const indexDir = join(workspaceRoot, ".gptwork", "context-index", goalId);
    if (await rmPath(indexDir)) deleted.context_index.push(indexDir);
  }

  // views/goals/*--gXXXX[/tasks/*--tYYYY], including Repair-/Followup- shells.
  const viewsRoot = join(workspaceRoot, ".gptwork", "views", "goals");
  for (const entry of await listNames(viewsRoot)) {
    if (!entry.isDirectory()) continue;
    const viewGoalDir = join(viewsRoot, entry.name);
    const goalMatch = nameMatchesAny(entry.name, [...goalTokens, ...titleTokens]);
    const looksLikeRepairOrFollowup = /^(repair|followup)[\s:_-]/i.test(entry.name);
    if (goalMatch || (looksLikeRepairOrFollowup && nameMatchesAny(entry.name, titleTokens))) {
      if (await rmPath(viewGoalDir)) deleted.views.push(viewGoalDir);
      continue;
    }
    // task-only cleanup under remaining goal views
    const tasksDir = join(viewGoalDir, "tasks");
    let removedTaskViews = 0;
    for (const taskEntry of await listNames(tasksDir)) {
      if (!taskEntry.isDirectory()) continue;
      if (nameMatchesAny(taskEntry.name, [...taskTokens, ...titleTokens])) {
        const p = join(tasksDir, taskEntry.name);
        if (await rmPath(p)) {
          deleted.views.push(p);
          removedTaskViews += 1;
        }
      }
    }
    if (removedTaskViews > 0) {
      const remaining = await listNames(tasksDir);
      if (remaining.length === 0 && looksLikeRepairOrFollowup) {
        if (await rmPath(viewGoalDir)) deleted.views.push(viewGoalDir);
      }
    }
  }

  for (const taskId of tasks) {
    const runDir = join(workspaceRoot, ".gptwork", "runs", taskId);
    if (await rmPath(runDir)) deleted.runs.push(runDir);

    // session control records/logs
    const sessionDir = join(workspaceRoot, ".gptwork", "codex-tui-sessions");
    for (const entry of await listNames(sessionDir)) {
      if (!entry.isFile()) continue;
      if (nameMatchesAny(entry.name, [...taskTokens, ...goalTokens, ...titleTokens])) {
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
      if (nameMatchesAny(entry.name, taskTokens)) {
        const p = join(lockRoot, entry.name);
        if (await rmPath(p)) deleted.locks.push(p);
      }
    }
  }

  // project-root mirror goals/views if different
  if (projectRoot && projectRoot !== workspaceRoot) {
    for (const goalId of goals) {
      const goalDir = join(projectRoot, ".gptwork", "goals", goalId);
      if (await rmPath(goalDir)) deleted.goals.push(goalDir);
    }
    const projectViewsRoot = join(projectRoot, ".gptwork", "views", "goals");
    for (const entry of await listNames(projectViewsRoot)) {
      if (!entry.isDirectory()) continue;
      if (nameMatchesAny(entry.name, [...goalTokens, ...taskTokens, ...titleTokens])) {
        const p = join(projectViewsRoot, entry.name);
        if (await rmPath(p)) deleted.views.push(p);
      }
    }
  }

  // marker files under workspace/project tmp and residual worktree copies
  const markerRoots = [
    join(workspaceRoot, ".gptwork", "tmp"),
    projectRoot ? join(projectRoot, ".gptwork", "tmp") : null,
  ].filter(Boolean);
  for (const root of markerRoots) {
    for (const entry of await listNames(root)) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      if (nameMatchesAny(entry.name, [...titleTokens, ...taskTokens, ...goalTokens])) {
        const p = join(root, entry.name);
        if (await rmPath(p)) deleted.markers.push(p);
      }
    }
  }

  // residual marker copies under worktrees
  const worktreeRoot = join(workspaceRoot, ".gptwork", "worktrees");
  for (const repo of await listNames(worktreeRoot)) {
    if (!repo.isDirectory()) continue;
    const repoDir = join(worktreeRoot, repo.name);
    for (const taskEntry of await listNames(repoDir)) {
      if (!taskEntry.isDirectory()) continue;
      if (tasks.length && !nameMatchesAny(taskEntry.name, taskTokens)) continue;
      const tmpDir = join(repoDir, taskEntry.name, ".gptwork", "tmp");
      for (const entry of await listNames(tmpDir)) {
        if (nameMatchesAny(entry.name, [...titleTokens, ...taskTokens, ...goalTokens])) {
          const p = join(tmpDir, entry.name);
          if (await rmPath(p)) deleted.markers.push(p);
        }
      }
    }
  }

  return deleted;
}
