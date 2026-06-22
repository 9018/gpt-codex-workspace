import { basename } from 'node:path';
import { findTask, updateTask, normalizeLegacyModes } from '../task-lifecycle.mjs';

/**
 * Factory for basic task MCP tool registration.
 * Dependencies (createTask, github) are passed in to avoid circular imports
 * from gptwork-server.mjs.
 */
export function createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github, eventLogger, hookBus }) {
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["task"], outputTemplate: "ui://widget/gptwork-card-v1.html" };
  return {
    create_task: tool({
      name: "create_task",
      description: "Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.",
      inputSchema: schema({
      title: { type: "string", description: "Task title summarizing the work to be done." },
      description: { type: "string", description: "Detailed task description or instructions." },
      assignee: { type: "string", description: "Who to assign the task to (e.g. codex, chatgpt).", default: "codex" },
      workspace_id: { type: "string", description: "Workspace ID for scoping." },
      mode: { type: "string", description: "Execution mode for Codex.", enum: ["standard", "readonly"] }
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
        return { tasks: tasks.slice(-limit).reverse() };
      },
    }),
    get_task: tool({
      name: "get_task",
      description: "Return a task.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => ({ task: await findTask(store, task_id) }),
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
