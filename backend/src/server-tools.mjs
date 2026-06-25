import { schema } from "./mcp-tooling.mjs";
import { readEvents } from "./event-log-service.mjs";
import { createTool } from "./tool-registry.mjs";
import { getRepoLockSummary, listRepoLocks } from "./repo-lock.mjs";
import { collectWorkerQueueCounts } from "./worker-queue-counts.mjs";
import { createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection } from "./workspace-lifecycle.mjs";
import { createTask, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage, ensureTaskGoal, normalizeAssignedTaskMode } from "./goal-task-lifecycle.mjs";
import { processGeneralTask } from "./task-general-processor.mjs";
import { runAssignedCodexTasks } from "./codex-worker.mjs";
import { createRestartToolsGroup } from "./tool-groups/restart-tools-group.mjs";
import { createRepoLockToolsGroup } from "./tool-groups/repo-lock-tools-group.mjs";
import { createExecutionToolsGroup } from "./tool-groups/task-execution-tools-group.mjs";
import { createProjectWorkspaceToolsGroup } from "./tool-groups/project-workspace-tools-group.mjs";
import { createGoalToolsGroup } from "./tool-groups/goal-tools-group.mjs";
import { createBasicTaskToolsGroup } from "./tool-groups/basic-task-tools-group.mjs";
import { createSessionInventoryToolsGroup } from "./tool-groups/session-inventory-tools-group.mjs";
import { createTaskCompletionToolsGroup } from "./tool-groups/task-completion-tools-group.mjs";
import { createChatGptRequestToolsGroup } from "./tool-groups/chatgpt-request-tools-group.mjs";
import { createBrowserToolsGroup } from "./tool-groups/browser-tools-group.mjs";
import { createBrowserInteractionToolsGroup } from "./tool-groups/browser-interaction-tools-group.mjs";
import { createRuntimeStatusToolsGroup } from "./tool-groups/runtime-status-tools-group.mjs";
import { createContextHealthToolsGroup } from "./tool-groups/context-health-tools-group.mjs";
import { createRepositoryToolsGroup } from "./tool-groups/repository-tools-group.mjs";
import { createWorkspaceReadToolsGroup } from "./tool-groups/workspace-read-tools-group.mjs";
import { createWorkspaceMutationToolsGroup } from "./tool-groups/workspace-mutation-tools-group.mjs";
import { createWorkspaceOperationsToolsGroup } from "./tool-groups/workspace-operations-tools-group.mjs";
import { createGitRemoteToolsGroup } from "./tool-groups/git-remote-tools-group.mjs";
import { createGithubSyncToolsGroup } from "./tool-groups/github-sync-tools-group.mjs";
import { createSystemDiagnosticsToolsGroup } from "./tool-groups/system-diagnostics-tools-group.mjs";
import { createGithubCommentsSyncToolsGroup } from "./tool-groups/github-comments-sync-tools-group.mjs";
import { createProjectContextToolsGroup } from "./tool-groups/project-context-tools-group.mjs";
import { createAgentRunToolsGroup } from "./tool-groups/agent-run-tools-group.mjs";
import { createSelfTestToolsGroup } from "./tool-groups/self-test-tools-group.mjs";
import { createGoalQueueToolsGroup } from "./tool-groups/goal-queue-tools-group.mjs";
import { createCleanupToolsGroup } from "./tool-groups/cleanup-tools-group.mjs";
import { createRecoveryToolsGroup } from "./tool-groups/recovery-tools-group.mjs";
import { createRetentionToolsGroup } from "./tool-groups/retention-tools-group.mjs";
import { resolveRepoDir, collectRuntimeGitInfoCached } from "./diagnostics-service.mjs";
import { createWorkflowToolsGroup } from "./tool-groups/workflow-tools-group.mjs";
import * as goalQueue from "./goal-queue.mjs";

export const VALID_TOOL_MODES = new Set(["minimal", "standard", "operator", "codex", "full"]);

export const TOOL_MODE_ALLOWLISTS = {
  minimal: new Set([
    "health_check",
    "runtime_status",
    "worker_status",
    "open_project_context",
    "create_encoded_goal",
    "get_task",
    "list_tasks",
  ]),
  standard: new Set([
    "gptwork_self_test",
    "health_check",
    "runtime_status",
    "worker_status",
    "gptwork_doctor",
    "github_status",
    "open_project_context",
    "project_context_status",
    "context_status",
    "context_prepare",
    "create_goal",
    "create_encoded_goal",
    "list_goals",
    "get_goal_context",
    "append_goal_message",
    "enqueue_goal",
    "list_goal_queue",
    "get_goal_queue",
    "start_next_queued_goal",
    "update_goal_queue_item",
    "cancel_goal_queue_item",
    "create_task",
    "list_tasks",
    "get_task",
    "append_task_log",
    "attach_task_artifact",
    "complete_task",
    "update_task_status",
    "request_human_review",
    "preview_codex_context",
    "read_text_file",
    "list_dir",
    "stat_path",
    "sha256_file",
    "search_files",
    "download_file_base64",
    "download_bundle_base64",
    "get_workspace_info",
    "list_workspaces",
    "list_projects",
    "get_project",
    "get_repository_status",
    "list_repositories",
    "resolve_canonical_repository",
    "sync_from_github",
    "sync_to_github",
    "sync_github_comments",
    "import_task_handoffs",
    "clear_repo_lock",
    "tmp_status",
    "cleanup_tmp",
    "goal_storage_status",
    "cleanup_goals",
    "retention_status",
    "retention_cleanup",
    "create_chatgpt_request",
    "answer_chatgpt_request",
    "get_chatgpt_request",
    "list_chatgpt_requests",
    "create_agent_run",
    "list_agent_runs",
    "get_agent_run",
    "append_agent_event",
    "complete_agent_run",
    "cancel_agent_run",
    "run_agent_pipeline",
    "handoff_to_agent",
    "read_handoff",
    "show_changes",
    "read_events",
    "tmp_status",
    "cleanup_tmp",
    "goal_storage_status",
    "cleanup_goals",
    "retention_status",
    "retention_cleanup",
  ]),
  operator: new Set([
    "gptwork_self_test",
    "health_check",
    "runtime_status",
    "worker_status",
    "gptwork_doctor",
    "github_status",
    "notification_status",
    "list_pending_restarts",
    "schedule_service_restart",
    "repo_lock_status",
    "list_repo_locks",
    "detect_stale_clones",
    "test_bark_notification",
    "register_repository",
    "list_repositories",
    "resolve_canonical_repository",
    "sync_from_github",
    "sync_to_github",
    "sync_github_comments",
    "import_task_handoffs",
  
    "list_goal_queue",
    "get_goal_queue",
    "clear_repo_lock",
    "tmp_status",
    "cleanup_tmp",
    "goal_storage_status",
    "cleanup_goals",
    "retention_status",
    "retention_cleanup",
  ]),
  codex: new Set([
    "gptwork_self_test",
    "health_check",
    "runtime_status",
    "worker_status",
    "open_project_context",
    "get_goal_context",
    "append_goal_message",
    "preview_codex_context",
    "run_assigned_codex_tasks",
    "list_tasks",
    "get_task",
    "append_task_log",
    "attach_task_artifact",
    "complete_task",
    "update_task_status",
    "read_text_file",
    "write_text_file",
    "list_dir",
    "stat_path",
    "search_files",
    "mkdir",
    "copy_path",
    "move_path",
    "delete_path",
    "upload_base64_file",
    "download_file_base64",
    "shell_exec",
    "git_remote_status",
    "git_remote_diff",
    "git_remote_changed_files",
    "create_agent_run",
    "list_agent_runs",
    "get_agent_run",
    "append_agent_event",
    "complete_agent_run",
    "cancel_agent_run",
    "run_agent_pipeline",
    "handoff_to_agent",
    "read_handoff",
    "show_changes",
    "read_events",
    "tmp_status",
    "cleanup_tmp",
    "goal_storage_status",
    "cleanup_goals",
    "retention_status",
    "retention_cleanup",
  ]),
};

export function normalizeToolMode(mode) {
  const normalized = String(mode || "standard").toLowerCase();
  return VALID_TOOL_MODES.has(normalized) ? normalized : "standard";
}

export function filterToolsForMode(tools, mode) {
  const normalized = normalizeToolMode(mode);
  if (normalized === "full") return tools;
  const allow = TOOL_MODE_ALLOWLISTS[normalized] || TOOL_MODE_ALLOWLISTS.standard;
  return Object.fromEntries(Object.entries(tools).filter(([name, descriptor]) => {
    const modes = descriptor.metadata?.modes || [];
    if (normalized === "standard") {
      return allow.has(name) || modes.includes("standard");
    }
    return allow.has(name) || modes.includes(normalized);
  }));
}

export function createTools({ store, config, browser, github, bark, envLoadResult, sources, registry, workerState, processStartedAt, notifyCreatedTaskIfNeeded, eventLogger, hookBus }) {
  const repoDir = resolveRepoDir();
  const tool = createTool;

  const tools = {
    ...createSystemDiagnosticsToolsGroup({ tool, schema, store, bark, workerState, collectWorkerQueueCounts }),
    ...createSelfTestToolsGroup({ tool, schema, config, bark, github, store, sources }),
    ...createProjectWorkspaceToolsGroup({ tool, schema, config, store, createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection }),
    ...createGoalToolsGroup({ tool, schema, config, store, eventLogger, hookBus, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }),
    ...createGoalQueueToolsGroup({ tool, schema, store, config, goalQueue }),
    ...createProjectContextToolsGroup({ tool, schema, config, store, workerState, registry }),
    ...createAgentRunToolsGroup({ tool, schema, store, config, eventLogger, hookBus }),

    ...createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github, eventLogger, hookBus }),
    ...createExecutionToolsGroup({ tool, schema, config, store, github, registry,
      normalizeAssignedTaskMode,
      ensureTaskGoal,
      notifyCreatedTaskIfNeeded,
      runAssignedCodexTasks: (store, config, github, args, context) => runAssignedCodexTasks(store, config, github, args, context, { processGeneralTask }),
    }),
    ...createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask }),
    ...createTaskCompletionToolsGroup({ tool, schema, config, store, github, eventLogger, hookBus }),
    ...createRestartToolsGroup({ tool, schema, config, store }),

    ...createChatGptRequestToolsGroup({ tool, schema, config, store, github }),

    ...createWorkspaceReadToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceMutationToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceOperationsToolsGroup({ tool, schema, store, config }),

    ...createGithubSyncToolsGroup({ tool, schema, store, github, config }),
    ...createRepositoryToolsGroup({ tool, schema, registry }),
    ...createContextHealthToolsGroup({ tool, schema, config, registry, store }),

    ...createGithubCommentsSyncToolsGroup({ tool, schema, store, github }),

    ...createBrowserToolsGroup({ tool, schema, browser }),
    ...createBrowserInteractionToolsGroup({ tool, schema, browser }),
    ...createGitRemoteToolsGroup({ tool, schema, registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote }),
   ...createRuntimeStatusToolsGroup({ tool, schema, config, sources, envLoadResult, bark, github, registry, store, workerState, PROCESS_STARTED_AT: processStartedAt, collectWorkerQueueCounts }),
   ...createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary, store }),

  ...createWorkflowToolsGroup({ tool, schema, store, config, workerState, collectWorkerQueueCounts }),
  ...createCleanupToolsGroup({ tool, schema, config }),
  ...createRetentionToolsGroup({ tool, schema, store, config }),
  ...createRecoveryToolsGroup({ tool, schema, store, config, envLoadResult, sources, registry, workerState, collectWorkerQueueCounts, repoDir, gitInfo: {}, PROCESS_STARTED_AT: processStartedAt }),
   read_events: tool({
      name: "read_events",
      description: "Read recent event log entries for monitoring and debugging.",
      inputSchema: schema({
      date: { type: "string", description: "Date to read events for, in ISO format (YYYY-MM-DD). Defaults to today.", examples: ["2026-06-22"] },
      limit: { type: "integer", description: "Maximum number of events to return.", minimum: 1, maximum: 1000, default: 100 }
    }),
      ...{ modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["system", "debug"] },
      handler: async ({ date, limit }) => {
        const events = await readEvents({ workspaceRoot: config.defaultWorkspaceRoot, date: date ? new Date(date) : undefined, limit: limit ? Number(limit) : 100 });
        return { events, count: events.length };
      },
    }),
  };
  return tools;
}

export function createDiscoverableTools(tools, mode) {
  return filterToolsForMode(tools, mode);
}
