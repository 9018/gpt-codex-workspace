import { basename } from 'node:path';
import { findTask, updateTask, normalizeLegacyModes } from '../task-lifecycle.mjs';

/**
 * Factory for basic task MCP tool registration.
 * Dependencies (createTask, github) are passed in to avoid circular imports
 * from gptwork-server.mjs.
 */
export function createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github, eventLogger, hookBus }) {
  return {
    create_task: tool(
      "Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.",
      schema({ title: "string", description: "string", assignee: "string", workspace_id: "string", mode: "string" }, ["title"]),
      async (args, context) => {
        const result = await createTask(store, config, args, context);
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.created", { task_id: result.task.id, title: result.task.title, assignee: result.task.assignee });
        await hookBus?.emit("onTaskCreated", { task: result.task });
        return result;
      },
    ),
    list_tasks: tool(
      "List project tasks, optionally filtered. Check what Codex is working on and what tasks are waiting or completed.",
      schema({ status: "string", assignee: "string", limit: "integer" }),
      async ({ status, assignee, limit = 50 }) => {
        const state = await store.load();
        await normalizeLegacyModes(store, state);
        let tasks = state.tasks;
        if (status) tasks = tasks.filter((task) => task.status === status);
        if (assignee) tasks = tasks.filter((task) => task.assignee === assignee);
        return { tasks: tasks.slice(-limit).reverse() };
      },
    ),
    get_task: tool(
      "Return a task.",
      schema({ task_id: "string" }, ["task_id"]),
      async ({ task_id }) => ({ task: await findTask(store, task_id) }),
    ),
    update_task_status: tool(
      "Update a task status. Syncs to GitHub if configured.",
      schema({ task_id: "string", status: "string" }, ["task_id", "status"]),
      async ({ task_id, status }) => {
        const result = await updateTask(store, task_id, (task) => { task.status = status; });
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.status_changed", { task_id, status });
        await hookBus?.emit("onTaskStatusChanged", { task: result.task });
        return result;
      },
    ),
    append_task_log: tool(
      "Append a task log entry.",
      schema({ task_id: "string", message: "string" }, ["task_id", "message"]),
      async ({ task_id, message }) => updateTask(store, task_id, (task) => { task.logs.push({ time: new Date().toISOString(), message }); }),
    ),
    attach_task_artifact: tool(
      "Attach a task artifact reference.",
      schema({ task_id: "string", path: "string", label: "string" }, ["task_id", "path"]),
      async ({ task_id, path, label }) => updateTask(store, task_id, (task) => { task.artifacts.push({ path, label: label || basename(path), time: new Date().toISOString() }); }),
    ),
  };
}
