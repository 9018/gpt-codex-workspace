import { basename } from 'node:path';
import { findTask, updateTask, normalizeLegacyModes } from '../task-lifecycle.mjs';
import { getTaskAcceptanceBundle } from '../review/task-acceptance-bundle.mjs';
import { getTaskReviewPacket } from '../review/review-packet-builder.mjs';
import { normalizeLegacyTaskWorkstream } from '../workstream/workstream-model.mjs';

/**
 * Factory for basic task MCP tool registration.
 * Dependencies (createTask, github) are passed in to avoid circular imports
 * from gptwork-server.mjs.
 */
export function createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github, eventLogger, hookBus }) {
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["task"], outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html" };
  return {
    create_task: tool({
      name: "create_task",
      description: "Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.",
      inputSchema: schema({
      title: { type: "string", description: "Task title summarizing the work to be done." },
      description: { type: "string", description: "Detailed task description or instructions." },
      assignee: { type: "string", description: "Who to assign the task to (e.g. codex, chatgpt).", default: "codex" },
      workspace_id: { type: "string", description: "Workspace ID for scoping." },
      mode: { type: "string", description: "Execution mode for Codex.", enum: ["standard", "readonly"] },
      notify: { type: "boolean", description: "Set false to suppress ordinary task Bark notifications for this task." },
      silent: { type: "boolean", description: "Set true to suppress ordinary task Bark notifications for this task." },
      suppress_notifications: { type: "boolean", description: "Set true to suppress ordinary task Bark notifications for this task." },
      notification_policy: { type: "string", description: "Task notification policy. Use 'silent' to suppress ordinary task Bark notifications." },
      metadata: { type: "object", description: "Optional structured task metadata, including notification policy flags." },
      workstream_id: { type: "string", description: "Optional Workstream identity for this Task." },
      root_goal_id: { type: "string", description: "Optional root Goal identity for this Task." },
      parent_goal_id: { type: "string", description: "Optional parent Goal identity for this Task." },
      phase: { type: "string", description: "Optional Workstream phase." },
      iteration: { type: "integer", description: "Optional non-negative Workstream iteration." },
      shard_key: { type: "string", description: "Optional Workstream shard key." },
      workflow_id: { type: "string", description: "Optional workflow identity." }
    }, ["title"]),
      ...common,
      handler: async (args, context) => {
        const result = await createTask(store, config, args, context);
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.created", { task_id: result.task.id, title: result.task.title, assignee: result.task.assignee });
        await hookBus?.emit("onTaskCreated", { task: result.task });
        return result;
      },
    }),
    list_tasks: tool({
      name: "list_tasks",
      description: "List project tasks, optionally filtered. Check what Codex is working on and what tasks are waiting or completed.",
      inputSchema: schema({ status: "string", assignee: "string", limit: "integer" }),
      ...common,
      handler: async ({ status, assignee, limit = 50 }) => {
        const state = await store.load();
        await normalizeLegacyModes(store, state);
        let tasks = state.tasks;
        if (status) tasks = tasks.filter((task) => task.status === status);
        if (assignee) tasks = tasks.filter((task) => task.assignee === assignee);
        const goalsById = new Map((state.goals || []).map((goal) => [goal.id, goal]));
        return {
          tasks: tasks
            .slice(-limit)
            .reverse()
            .map((task) => normalizeLegacyTaskWorkstream(task, goalsById.get(task.goal_id))),
        };
      },
    }),
    get_task: tool({
      name: "get_task",
      description: "Return a task.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => {
        const task = await findTask(store, task_id);
        const state = await store.load();
        const goal = task.goal_id
          ? (typeof store.findGoalById === "function"
              ? await store.findGoalById(task.goal_id)
              : state.goals.find((item) => item.id === task.goal_id))
          : null;
        return { task: normalizeLegacyTaskWorkstream(task, goal) };
      },
    }),
    get_task_acceptance_bundle: tool({
      name: "get_task_acceptance_bundle",
      description: "Return compact task acceptance evidence for review or closure without full goal context, transcripts, memories, or large diffs.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => ({ acceptance_bundle: await getTaskAcceptanceBundle({ store, config, task_id }) }),
    }),
    get_task_review_packet: tool({
      name: "get_task_review_packet",
      description: "Return a minimal task review packet with result, verification, blockers, changed files, and recommended next action.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => ({ review_packet: await getTaskReviewPacket({ store, config, task_id }) }),
    }),
    update_task_status: tool({
      name: "update_task_status",
      description: "Update a task status. Syncs to GitHub if configured.",
      inputSchema: schema({ task_id: "string", status: "string" }, ["task_id", "status"]),
      ...common,
      handler: async ({ task_id, status }) => {
        const result = await updateTask(store, task_id, (task) => { task.status = status; });
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.status_changed", { task_id, status });
        await hookBus?.emit("onTaskStatusChanged", { task: result.task });
        return result;
      },
    }),
    append_task_log: tool({
      name: "append_task_log",
      description: "Append a task log entry.",
      inputSchema: schema({ task_id: "string", message: "string" }, ["task_id", "message"]),
      ...common,
      handler: async ({ task_id, message }) => updateTask(store, task_id, (task) => { task.logs.push({ time: new Date().toISOString(), message }); }),
    }),
    attach_task_artifact: tool({
      name: "attach_task_artifact",
      description: "Attach a task artifact reference.",
      inputSchema: schema({ task_id: "string", path: "string", label: "string" }, ["task_id", "path"]),
      ...common,
      handler: async ({ task_id, path, label }) => updateTask(store, task_id, (task) => { task.artifacts.push({ path, label: label || basename(path), time: new Date().toISOString() }); }),
    }),
  };
}
