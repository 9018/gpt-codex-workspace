import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatSize, loadProjectEnv, loadProjectMd } from "./codex-context-builder.mjs";
import { getPendingRestartsDir, scanPendingRestartMarkers } from "./safe-restart.mjs";
import { requireScope } from "./auth-context.mjs";
import { findTask } from "./task-lifecycle.mjs";

/**
 * Try to find the repo root directory by walking up from cwd looking for .git.
 */
export function resolveRepoDir() {
  const start = process.cwd();
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(join(dir, ".git")).isDirectory()) return dir;
    } catch (e) {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Determine whether runtime env loaded Bark config vars. */
export function determineBarkConfigSource(envLoadResultKeys) {
  const barkVars = ["GPTWORK_BARK_ENABLED", "GPTWORK_BARK_URL", "GPTWORK_BARK_KEY", "GPTWORK_BARK_GROUP", "GPTWORK_BARK_SOUND", "GPTWORK_BARK_LEVEL"];
  const fromEnv = barkVars.filter(v => envLoadResultKeys.includes(v));
  if (fromEnv.length > 0) return "workspace-runtime-env";
  const anySet = barkVars.some(v => process.env[v] !== undefined);
  return anySet ? "process.env" : "disabled";
}

/**
 * Collect git info from a repo directory: HEAD commit, remote HEAD,
 * and worktree dirty state.
 */
export function collectRuntimeGitInfo(repoDir) {
  let repo_head = null, remote_head = null, running_commit = null;
  let worktree_dirty = false, dirty_paths = [];

  if (repoDir) {
    try {
      const out = execSync("git rev-parse HEAD 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
      if (out) repo_head = out;
    } catch (e) {}
    try {
      const line = execSync("git ls-remote origin refs/heads/main 2>/dev/null", { cwd: repoDir, timeout: 2000, encoding: "utf8" }).trim();
      if (line) remote_head = line.split(/\s+/)[0];
    } catch (e) {}
    try {
      const statusOut = execSync("git status --short 2>/dev/null", { cwd: repoDir, timeout: 5000, encoding: "utf8" }).trim();
      if (statusOut.length > 0) {
        worktree_dirty = true;
        dirty_paths = statusOut.split("\n").filter(l => l.trim()).map(l => l.trim());
      }
    } catch (e) {}
    running_commit = repo_head;
  }

  return { repo_head, remote_head, running_commit, worktree_dirty, dirty_paths };
}

/**
 * Collect restart marker summary from workspace root.
 * Returns total count, active count, per-status counts, and marker dir existence.
 */
export async function collectRestartMarkerStatus(workspaceRoot) {
  const result = { total_count: 0, active_count: 0, statuses: { pending: 0, scheduled: 0, restarted: 0, verified: 0, failed: 0 }, marker_dir_exists: false };
  try {
    const markerDir = getPendingRestartsDir(workspaceRoot);
    result.marker_dir_exists = existsSync(markerDir);
    const markers = await scanPendingRestartMarkers(workspaceRoot);
    result.total_count = markers.length;
    result.active_count = markers.filter(m => ["pending", "scheduled", "restarted"].includes(m.status)).length;
    for (const m of markers) {
      if (m.status && result.statuses[m.status] !== undefined) {
        result.statuses[m.status]++;
      }
    }
  } catch (e) { /* non-fatal */ }
  return result;
}

/**
 * Shared context status query used by context_status/project_context_status
 * and context_prepare handlers. Accepts { config, registry, store } as
 * explicit dependencies.
 */
export async function queryContextStatus(task_id, context, { config, registry, store }) {
  requireScope(context, "task:read");

  // 1. Resolve canonical repo info
  const workspaceRoot = config.defaultWorkspaceRoot;
  let canonicalRepoPath = config.defaultRepoPath || null;
  let repoRecord = null;
  let repoRegistered = false;

  if (registry) {
    const defaultRepo = registry.getDefaultRepo() || null;
    if (defaultRepo && typeof defaultRepo === "object") {
      repoRecord = defaultRepo;
    }
    if (!repoRecord && config.defaultRepoPath) {
      repoRecord = registry.findByPath(config.defaultRepoPath) || null;
    }
    if (repoRecord) repoRegistered = true;
    if (repoRecord && repoRecord.canonical_path) {
      canonicalRepoPath = repoRecord.canonical_path;
    }
  }

  // 2. Project context files (safe, no secret values)
  const projectEnv = await loadProjectEnv(canonicalRepoPath);
  const projectMd = await loadProjectMd(canonicalRepoPath);

  // Count secret-like key names (pattern match only, no values exposed)
  const secretPatterns = ["SECRET", "KEY", "TOKEN", "PASSWORD", "PASS", "PRIVATE", "CREDENTIAL", "API_KEY"];
  const secretLikeKeys = projectEnv.keys.filter(function(k) {
    const upper = k.toUpperCase();
    return secretPatterns.some(function(p) { return upper.includes(p); });
  });

  // 3. Context source precedence summary
  const contextSourcePrecedence = [
    { rank: 1, source: "task.description / task fields", description: "Direct task metadata from the task object" },
    { rank: 2, source: "linked goal prompt/context files", description: "goal.md and context.json from the linked goal workspace files" },
    { rank: 3, source: "project.md / project.env", description: "Project-level context files under canonical repo .gptwork/" },
    { rank: 4, source: "durable goal transcript/memories", description: "Transcript and memory items from goal conversation history" },
    { rank: 5, source: "runtime defaults / repo registry", description: "Workspace root, state path, exec timeout, registered repo metadata" },
  ];

  // 4. Base warnings
  const warnings = [];
  if (!canonicalRepoPath) {
    warnings.push({ severity: "warning", code: "missing_canonical_repo", message: "No canonical repo path configured. Context will lack repo-specific project files." });
  }
  if (!projectMd.ok) {
    warnings.push({ severity: "warning", code: "missing_project_md", message: "No project.md found under canonical repo. Project-level Markdown context will not be loaded." });
  }
  if (projectEnv.ok && projectEnv.keys.length === 0) {
    warnings.push({ severity: "warning", code: "empty_project_env", message: "project.env exists but appears empty (no KEY=VALUE pairs found)." });
  }

  // Dirty worktree check
  if (canonicalRepoPath) {
    try {
      if (existsSync(join(canonicalRepoPath, ".git"))) {
        const dirtyOut = execSync("git status --short 2>/dev/null", { cwd: canonicalRepoPath, timeout: 5000, encoding: "utf8" }).trim();
        if (dirtyOut.length > 0) {
          warnings.push({ severity: "warning", code: "dirty_worktree", message: "Canonical repo has uncommitted changes. Context will reflect dirty state." });
        }
      }
    } catch (e) {}
  }

  // Stale clone check
  try {
    if (workspaceRoot) {
      const dirEntries = readdirSync(workspaceRoot, { withFileTypes: true });
      const staleClones = dirEntries.filter(function(e) { return e.isDirectory() && e.name.startsWith(".tmp-"); });
      if (staleClones.length > 0) {
        warnings.push({ severity: "info", code: "stale_clones", message: staleClones.length + " stale temporary clone(s) detected." });
      }
    }
  } catch (e) {}

  // 5. Task-specific diagnostics (optional)
  let taskInfo = null;
  if (task_id) {
    try {
      const task = await findTask(store, task_id);
      const state = await store.load();
      const goal = task.goal_id ? state.goals.find(function(g) { return g.id === task.goal_id; }) : null;

      let previewAvailable = false;
      let approximateContextBytes = 0;
      let transcriptCount = null;
      let memoryCount = 0;

      if (goal) {
        const workspace = state.workspaces.find(function(w) { return w.id === task.workspace_id; });
        if (workspace) {
          const transcriptPath = join(workspace.root, ".gptwork/goals/" + goal.id + "/transcript.md");
          try {
            const s = statSync(transcriptPath);
            if (s.isFile()) {
              previewAvailable = true;
              approximateContextBytes += s.size;
              transcriptCount = 0;
            }
          } catch (e) {}

          // Count memories from context.json
          try {
            const cjPath = join(workspace.root, ".gptwork/goals/" + goal.id + "/context.json");
            const cjRaw = readFileSync(cjPath, "utf8");
            const cj = JSON.parse(cjRaw);
            memoryCount = Array.isArray(cj.memories) ? cj.memories.length : 0;
          } catch (e) {}

          // Estimate context size from task + goal + project files
          approximateContextBytes += (task.description || "").length;
          approximateContextBytes += (goal.goal_prompt || "").length;
          if (projectMd.ok) approximateContextBytes += projectMd.size;
          // Warn when task workspace type is SSH (Codex execution requires hosted workspace)
          if (workspace.type === "ssh") {
            warnings.push({ severity: "warning", code: "ssh_workspace", message: "SSH workspaces support file/shell tools only. Codex worker execution requires hosted workspace." });
          }
        }

        if (!task.goal_id) {
          warnings.push({ severity: "warning", code: "task_no_linked_goal", message: "Task has no linked goal. Codex will not have a goal.md to follow." });
        }
      }

      if (approximateContextBytes > 100 * 1024) {
        warnings.push({ severity: "warning", code: "huge_context", message: "Approximate context size is " + formatSize(approximateContextBytes) + ". Large contexts may degrade Codex performance." });
      }

      taskInfo = {
        task_id: task.id,
        task_status: task.status,
        linked_goal_id: task.goal_id || null,
        preview_available: previewAvailable,
        transcript_count: transcriptCount,
        memory_count: memoryCount,
        approximate_context_bytes: approximateContextBytes,
      };
    } catch (e) {
      // task not found or error resolving — still return base diagnostics
    }
  }

  const result = {
    canonical_repo_path: canonicalRepoPath,
    repo_registered: repoRegistered,
    workspace_root: workspaceRoot,
    project_context: {
      project_md_exists: projectMd.ok,
      project_md_path: projectMd.path,
      project_md_size_bytes: projectMd.size,
      project_env_exists: projectEnv.ok,
      project_env_path: projectEnv.path,
      project_env_key_count: projectEnv.keys.length,
      project_env_secret_like_key_count: secretLikeKeys.length,
      redacted_key_names: secretLikeKeys.length > 0 ? secretLikeKeys : [],
    },
    context_source_precedence: contextSourcePrecedence,
    warnings: warnings,
  };
  if (taskInfo) result.task = taskInfo;
  return result;
}
