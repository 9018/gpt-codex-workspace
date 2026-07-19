import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  selectWorkspace,
  requireScope,
} from '../auth-context.mjs';
import { findTask, updateTask } from '../task-lifecycle.mjs';
import { goalWorkspaceFiles } from '../goal-files.mjs';
import { buildCodexContext, formatSize } from '../codex-context-builder.mjs';
import { buildCodexPrompt } from '../codex-prompt-builder.mjs';
import { getRepoStatus } from '../repo-registry.mjs';
import { buildContextPreviewV2 } from '../context-preview-v2.mjs';

/**
 * Factory for task execution and preview MCP tool registration.
 * Handler function dependencies are passed in to avoid circular imports
 * from gptwork-server.mjs.
 */
export function createExecutionToolsGroup({
  tool, schema, config, store, github, registry,
  normalizeAssignedTaskMode,
  ensureTaskGoal,
  notifyCreatedTaskIfNeeded,
  runAssignedCodexTasks,
}) {
  return {
    assign_task_to_codex: tool(
      "Assign a task to Codex for execution. Ordinary tasks run in builder mode so Codex may edit files and perform implementation or deployment steps according to the task. The server ignores readonly for ordinary tasks; only the dedicated safe Codex session inventory task can remain readonly. Pass mode=deploy for Docker/service deployment or mode=admin for privileged maintenance.",
      schema({ task_id: "string", mode: "string" }, ["task_id"]),
      async ({ task_id, mode }, context) => {
        const result = await updateTask(store, task_id, (task) => {
          task.assignee = "codex";
          task.status = "assigned";
          task.mode = normalizeAssignedTaskMode(task, mode);
        });
        const linked = await ensureTaskGoal(store, config, result.task.id, context, { assign_to_codex: true, sync_execution_profile: true });
        // Send created notification for newly assigned Codex task (after ensureTaskGoal handles goal linking)
        notifyCreatedTaskIfNeeded(result.task);
        github.syncTask(result.task).catch(() => {});
        return linked;
      },
    ),
    run_assigned_codex_tasks: tool(
      "Process assigned tasks. For session inventory tasks (readonly): safe metadata listing. For builder/deploy tasks: workspace inspection (file listing, port checks, health probes). Supports bounded concurrent execution.",
      schema({ limit: "integer", concurrency: "integer" }),
      async (args, context) => runAssignedCodexTasks(store, config, github, args, context),
    ),
    preview_codex_context: tool(
      "Show what Codex will see before executing a task: task status, linked goal, workspace paths, canonical repo, project context files, transcript/memory counts, acceptance criteria, size metrics, and warnings for missing repo, dirty worktree, stale clone, or huge transcript. Use this before large Codex runs to verify the execution environment.",
      schema({ task_id: "string" }, ["task_id"]),
      async ({ task_id }, context) => {
        requireScope(context, "task:read");
        const task = await findTask(store, task_id);
        const workspace = await selectWorkspace(store, task.workspace_id, context);
        const goal = task.goal_id
          ? (typeof store.findGoalById === "function"
              ? await store.findGoalById(task.goal_id)
              : (await store.load()).goals.find(function(g) { return g.id === task.goal_id; }))
          : null;
        let contextJson = null;
        if (goal && workspace) {
          try { contextJson = JSON.parse(await readFile(join(workspace.root, ".gptwork/goals/" + goal.id + "/context.json"), "utf8")); } catch {}
        }
        let repoRecord = null;
        let repoStatus = null;
        if (registry) {
          const defaultRepo = registry.getDefaultRepo() || null;
          if (defaultRepo && typeof defaultRepo === "object") {
            repoRecord = defaultRepo;
          }
          if (!repoRecord && config.defaultRepoPath) {
            repoRecord = registry.findByPath(config.defaultRepoPath) || null;
          }
          if (repoRecord) {
            try { repoStatus = await getRepoStatus(repoRecord, config.defaultWorkspaceRoot, registry); } catch {}
          } else if (config.defaultRepoPath) {
            try { repoStatus = await getRepoStatus({ canonical_path: config.defaultRepoPath, default_branch: config.defaultBranch || "main", repo_id: "default", remote_url: "" }, config.defaultWorkspaceRoot); } catch {}
          }
        }
        const { context: ctx, preview } = await buildCodexContext({
          taskId: task.id,
          task,
          goal,
          contextJson,
          workspace,
          config,
          repoStatus,
          repoRecord,
        });
        const workspaceFiles = goal ? goalWorkspaceFiles(goal) : null;
        const { promptBytes } = buildCodexPrompt({
          task,
          goal,
          workspaceFiles,
          workspaceRoot: workspace.root,
          defaultRepoPath: config.defaultRepoPath,
        });
        const context_v2 = await buildContextPreviewV2({
          workspaceRoot: workspace.root,
          task,
          goal: goal || {},
          contextJson: ctx,
        });
        return {
          context: ctx,
          context_v2,
          task_context: context_v2.task_context,
          workstream_context: context_v2.workstream_context,
          raw_conversation: context_v2.raw_conversation,
          role_views: context_v2.role_views,
          excluded_sources: context_v2.excluded_sources,
          freshness: context_v2.freshness,
          warnings_v2: context_v2.warnings,
          preview,
          preview_text: preview,
          actual_prompt_bytes: promptBytes,
          actual_prompt_warning: promptBytes > 100 * 1024
            ? `Prompt is large (${formatSize(promptBytes)}). Codex may struggle with large context.`
            : undefined,
        };
      },
    ),
  };
}
