import { readFile, stat } from "node:fs/promises";

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
