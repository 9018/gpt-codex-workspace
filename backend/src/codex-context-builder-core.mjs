import { join } from "node:path";
import { loadProjectEnv, loadProjectMd } from "./codex-context-loaders.mjs";
import { countMemories, formatSize, generateWarnings, inspectTranscript } from "./codex-context-inspection.mjs";

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
          mode: task.mode || "full",
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
