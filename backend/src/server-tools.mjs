import { schema } from "./mcp-tooling.mjs";
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

export function createTools({ store, config, browser, github, bark, envLoadResult, sources, registry, workerState, processStartedAt, notifyCreatedTaskIfNeeded }) {
  const tool = createTool;

  const tools = {
    ...createSystemDiagnosticsToolsGroup({ tool, schema, store, bark, workerState, collectWorkerQueueCounts }),
    ...createProjectWorkspaceToolsGroup({ tool, schema, config, store, createWorkspace, updateWorkspace, deleteWorkspace, testWorkspaceConnection }),
    ...createGoalToolsGroup({ tool, schema, config, store, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }),

    ...createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github }),
    ...createExecutionToolsGroup({ tool, schema, config, store, github, registry,
      normalizeAssignedTaskMode,
      ensureTaskGoal,
      notifyCreatedTaskIfNeeded,
      runAssignedCodexTasks: (store, config, github, args, context) => runAssignedCodexTasks(store, config, github, args, context, { processGeneralTask }),
    }),
    ...createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask }),
    ...createTaskCompletionToolsGroup({ tool, schema, config, store, github }),
    ...createRestartToolsGroup({ tool, schema, config, store }),

    ...createChatGptRequestToolsGroup({ tool, schema, config, store, github }),

    ...createWorkspaceReadToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceMutationToolsGroup({ tool, schema, store, config }),
    ...createWorkspaceOperationsToolsGroup({ tool, schema, store, config }),

    ...createGithubSyncToolsGroup({ tool, schema, store, github }),
    ...createRepositoryToolsGroup({ tool, schema, registry }),
    ...createContextHealthToolsGroup({ tool, schema, config, registry, store }),

    ...createGithubCommentsSyncToolsGroup({ tool, schema, store, github }),

    ...createBrowserToolsGroup({ tool, schema, browser }),
    ...createBrowserInteractionToolsGroup({ tool, schema, browser }),
    ...createGitRemoteToolsGroup({ tool, schema, registry, defaultWorkspaceRoot: config.defaultWorkspaceRoot, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch, defaultRepoPath: config.defaultRepoPath, defaultRemote: config.defaultRemote }),
    ...createRuntimeStatusToolsGroup({ tool, schema, config, sources, envLoadResult, bark, github, registry, store, workerState, PROCESS_STARTED_AT: processStartedAt, collectWorkerQueueCounts }),
    ...createRepoLockToolsGroup({ tool, schema, config, listRepoLocks, getRepoLockSummary }),
  };
  return tools;
}

