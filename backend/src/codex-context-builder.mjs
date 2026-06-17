/**
 * Codex context builder/packer.
 *
 * Creates a deterministic Codex execution context from task_id and/or goal_id.
 * Produces a machine-readable context object and a human-readable prompt/preview.
 *
 * Project-level context files (.gptwork/project.md, .gptwork/project.env) under
 * the canonical repo path are discovered and loaded on each build.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Project-level context loading
// ---------------------------------------------------------------------------

/**
 * Load project-level .gptwork/project.env from canonical repo path.
 * Parsed like runtime.env: KEY=VALUE, blank lines and # comments ignored.
 * Does NOT mutate process.env — returns a plain object.
 *
 * @param {string} repoPath - Absolute path to the canonical repo clone.
 * @returns {{ ok: boolean, path: string|null, vars: Record<string,string>, keys: string[] }}
 */
export async function loadProjectEnv(repoPath) {
  if (!repoPath) return { ok: false, path: null, vars: {}, keys: [] };
  const filePath = join(repoPath, ".gptwork", "project.env");
  try {
    const text = await readFile(filePath, "utf8");
    const vars = {};
    const keys = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim();
      if (!k) continue;
      vars[k] = v;
      keys.push(k);
    }
    return { ok: true, path: filePath, vars, keys };
  } catch {
    return { ok: false, path: null, vars: {}, keys: [] };
  }
}

/**
 * Load project-level .gptwork/project.md from canonical repo path.
 *
 * @param {string} repoPath - Absolute path to the canonical repo clone.
 * @returns {{ ok: boolean, path: string|null, content: string|null, size: number }}
 */
export async function loadProjectMd(repoPath) {
  if (!repoPath) return { ok: false, path: null, content: null, size: 0 };
  const filePath = join(repoPath, ".gptwork", "project.md");
  try {
    const bytes = await readFile(filePath);
    return { ok: true, path: filePath, content: bytes.toString("utf8"), size: bytes.length };
  } catch {
    return { ok: false, path: null, content: null, size: 0 };
  }
}

// ---------------------------------------------------------------------------
// Workspace file helpers
// ---------------------------------------------------------------------------

/**
 * Get a human-readable file size string.
 */
export function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Estimate the number of messages in a transcript file and total bytes.
 */
export async function inspectTranscript(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return { exists: false, size: 0, message_count: 0, size_label: "0 B" };
    const text = await readFile(path, "utf8");
    // Count lines starting with common message markers
    const messageCount = (text.match(/^## /gm) || []).length;
    return {
      exists: true,
      size: s.size,
      message_count: messageCount,
      size_label: formatSize(s.size),
    };
  } catch {
    return { exists: false, size: 0, message_count: 0, size_label: "0 B" };
  }
}

/**
 * Count memories from context.json's conversations array.
 * @param {object} contextJson - Parsed context.json object.
 * @returns {number}
 */
export function countMemories(contextJson) {
  if (!contextJson) return 0;
  const memories = contextJson.memories;
  if (!Array.isArray(memories)) return 0;
  return memories.length;
}

// ---------------------------------------------------------------------------
// Warning generation
// ---------------------------------------------------------------------------

const HUGE_TRANSCRIPT_BYTES = 100 * 1024; // 100 KB

export function generateWarnings(task, goal, contextJson, repoStatus, transcriptInfo, repoRecord, workspace) {
  const warnings = [];

  if (!repoRecord) {
    warnings.push({ severity: "warning", code: "missing_repo", message: "No registered repository found. Codex will not have a canonical repo path." });
  } else if (repoStatus) {
    if (repoStatus.has_uncommitted) {
      warnings.push({ severity: "warning", code: "dirty_worktree", message: "Canonical repo has uncommitted changes. Codex will work on a dirty worktree." });
    }
    if (repoStatus.ahead > 0 || repoStatus.behind > 0) {
      warnings.push({ severity: "info", code: "stale_clone", message: `Repo is ${repoStatus.ahead} ahead, ${repoStatus.behind} behind origin/${repoStatus.default_branch}.` });
    }
  }

  if (!goal) {
    warnings.push({ severity: "warning", code: "missing_goal", message: "No linked goal found. Codex will not have a goal.md to follow." });
  }

  if (transcriptInfo.exists && transcriptInfo.size > HUGE_TRANSCRIPT_BYTES) {
    warnings.push({ severity: "warning", code: "huge_transcript", message: `Transcript is ${transcriptInfo.size_label}. Codex may struggle with large context.` });
  }


  // Warn when workspace type is SSH (Codex execution not supported for SSH)
  if (workspace && workspace.type === "ssh") {
    warnings.push({ severity: "warning", code: "ssh_workspace", message: "SSH workspaces support file/shell tools only. Codex worker execution requires hosted workspace." });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic Codex execution context from task_id and/or goal_id.
 *
 * @param {object} options
 * @param {string}  options.taskId         - The task ID.
 * @param {object}  options.task           - The task object (from state store).
 * @param {object}  [options.goal]         - The linked goal object, if any.
 * @param {object}  [options.contextJson]  - Parsed context.json from goal workspace.
 * @param {object}  [options.workspace]    - The workspace object.
 * @param {object}  [options.store]        - StateStore instance (for loading state).
 * @param {object}  [options.registry]     - RepoRegistry instance.
 * @param {object}  [options.config]       - Runtime config.
 * @param {object}  [options.repoStatus]   - Pre-computed repo status from getRepoStatus.
 * @param {object}  [options.repoRecord]   - The RepoRecord for the canonical repo.
 * @returns {Promise<{ context: object, preview: string }>}
 */
export async function buildCodexContext(options = {}) {
  const {
    taskId,
    task,
    goal,
    contextJson,
    workspace,
    config,
    repoStatus: externalRepoStatus,
    repoRecord: externalRepoRecord,
  } = options;

  // Resolve repo
  const repoRecord = externalRepoRecord || null;
  const repoStatus = externalRepoStatus || null;
  const canonicalRepoPath = repoRecord?.canonical_path || config?.defaultRepoPath || null;

  // Load project context files
  const projectEnv = await loadProjectEnv(canonicalRepoPath);
  const projectMd = await loadProjectMd(canonicalRepoPath);

  // Transcript info
  let transcriptInfo = { exists: false, size: 0, message_count: 0, size_label: "0 B" };
  if (goal && workspace) {
    const transcriptPath = join(
      workspace.root,
      `.gptwork/goals/${goal.id}/transcript.md`
    );
    transcriptInfo = await inspectTranscript(transcriptPath);
  }

  // Memory count
  const memoryCount = countMemories(contextJson);

  // Warnings
  const warnings = generateWarnings(
    task, goal, contextJson, repoStatus, transcriptInfo, repoRecord, workspace
  );

  // Size metrics
  const sizeMetrics = {
    transcript_bytes: transcriptInfo.size,
    transcript_size_label: transcriptInfo.size_label,
    transcript_message_count: transcriptInfo.message_count,
    memory_count: memoryCount,
    project_env_keys: projectEnv.keys.length,
    project_md_bytes: projectMd.size,
  };

  // Build machine-readable context
  const ctx = {
    task: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
          mode: task.mode || "builder",
          assignee: task.assignee,
          workspace_id: task.workspace_id,
        }
      : { id: taskId, title: null, status: null, mode: null, assignee: null, workspace_id: null },
    goal: goal
      ? {
          id: goal.id,
          mode: goal.mode,
          status: goal.status,
          title: goal.title,
        }
      : null,
    workspace: workspace
      ? {
          id: workspace.id,
          root: workspace.root,
          type: workspace.type,
        }
      : null,
    canonical_repo: {
      path: canonicalRepoPath,
      record: repoRecord
        ? {
            repo_id: repoRecord.repo_id,
            remote_url: repoRecord.remote_url,
            default_branch: repoRecord.default_branch,
            owner: repoRecord.owner,
            repo_name: repoRecord.repo_name,
            host: repoRecord.host,
          }
        : null,
      status: repoStatus || null,
    },
    project_context: {
      project_md: { ok: projectMd.ok, path: projectMd.path, size: projectMd.size },
      project_env: { ok: projectEnv.ok, path: projectEnv.path, keys: projectEnv.keys },
    },
    size_metrics: sizeMetrics,
    warnings,
    runtime: config
      ? {
          workspace_root: config.defaultWorkspaceRoot || config.workspaceRoot,
          state_path: config.statePath,
          codex_exec_timeout: config.codexExecTimeout,
          codex_exec_args: config.codexExecArgs,
        }
      : null,
    built_at: new Date().toISOString(),
  };

  // Build human-readable preview text
  const sep = "\u2500".repeat(56);
  let preview = "";

  preview += "Codex Context Preview\n";
  preview += sep + "\n\n";

  // Task info
  preview += "  Task:          " + (ctx.task.title || "(no title)") + "\n";
  preview += "  Task ID:       " + ctx.task.id + "\n";
  preview += "  Status:        " + (ctx.task.status || "\u2014") + "\n";
  preview += "  Mode:          " + (ctx.task.mode || "\u2014") + "\n";
  preview += "\n";

  // Goal info
  if (ctx.goal) {
    preview += "  Goal ID:       " + ctx.goal.id + "\n";
    preview += "  Goal Status:   " + (ctx.goal.status || "\u2014") + "\n";
    preview += "  Goal Mode:     " + (ctx.goal.mode || "\u2014") + "\n";
  } else {
    preview += "  Goal:          (none)\n";
  }
  preview += "\n";

  // Workspace
  if (ctx.workspace) {
    preview += "  Workspace:     " + ctx.workspace.id + " (" + ctx.workspace.type + ")\n";
    preview += "  Workspace Root: " + ctx.workspace.root + "\n";
  }
  preview += "\n";

  // Repo
  if (canonicalRepoPath) {
    preview += "  Canonical Repo: " + canonicalRepoPath + "\n";
    if (repoRecord) {
      preview += "  Remote URL:    " + repoRecord.remote_url + "\n";
      preview += "  Branch:        " + repoRecord.default_branch + "\n";
    }
  } else {
    preview += "  Canonical Repo: (not configured)\n";
  }
  preview += "\n";

  // Runtime paths
  if (ctx.runtime) {
    preview += "  State Path:    " + ctx.runtime.state_path + "\n";
    preview += "  Exec Timeout:  " + ctx.runtime.codex_exec_timeout + "s\n";
    preview += "  Exec Args:     " + (ctx.runtime.codex_exec_args || "(none)") + "\n";
  }
  preview += "\n";

  // Project context files
  preview += "  " + sep + "\n";
  preview += "  Project Context Files:\n";
  preview += "    project.md:   " + (projectMd.ok ? "found (" + formatSize(projectMd.size) + ")" : "not found") + "\n";
  preview += "    project.env:  " + (projectEnv.ok ? "found (" + projectEnv.keys.length + " vars)" : "not found") + "\n";
  preview += "\n";

  // Transcript / Memory
  preview += "  Transcript:    " + (transcriptInfo.exists ? transcriptInfo.size_label + " (" + transcriptInfo.message_count + " messages)" : "not available") + "\n";
  preview += "  Memories:      " + (memoryCount > 0 ? memoryCount + " memory items" : "none") + "\n";
  preview += "\n";

  // Size metrics
  preview += "  " + sep + "\n";
  preview += "  Size Metrics:\n";
  for (const [key, val] of Object.entries(sizeMetrics)) {
    preview += "    " + key + ": " + val + "\n";
  }
  preview += "\n";

  // Warnings
  if (warnings.length > 0) {
    preview += "  " + sep + "\n";
    preview += "  Warnings:\n";
    for (const w of warnings) {
      preview += "    [" + w.severity + "] " + w.code + ": " + w.message + "\n";
    }
    preview += "\n";
  }

  // Repo status detail
  if (repoStatus) {
    preview += "  " + sep + "\n";
    preview += "  Repo Status:\n";
    preview += "    Branch:       " + (repoStatus.current_branch || "\u2014") + "\n";
    preview += "    Local HEAD:   " + (repoStatus.local_head || "\u2014") + "\n";
    preview += "    Remote HEAD:  " + (repoStatus.remote_head || "\u2014") + "\n";
    preview += "    Ahead/Behind: " + repoStatus.ahead + "/" + repoStatus.behind + "\n";
    preview += "    Uncommitted:  " + (repoStatus.has_uncommitted ? "YES" : "no") + "\n";
    preview += "\n";
  }

  preview += "  " + sep + "\n";
  preview += "  Built at:      " + ctx.built_at + "\n";

  return { context: ctx, preview };
}
