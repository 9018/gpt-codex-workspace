import { randomUUID } from "node:crypto";
import { defaultTokenContext, requireProjectAccess, requireScope, requireWorkspaceAccess } from "./auth-context.mjs";
import { isCodexSessionInventoryTaskKind } from "./task-status.mjs";
import { ensureGoalState } from "./task-lifecycle.mjs";
import { ensureTaskGoal } from "./goal-task-ensure.mjs";
import { normalizeCreatedTaskMode } from "./goal-task-task-factory.mjs";

export async function createTask(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  const state = await store.load();
  ensureGoalState(state);
  requireProjectAccess(context, args.project_id || "default");
  if (args.workspace_id) requireWorkspaceAccess(context, args.workspace_id);
  const now = new Date().toISOString();
  const task = {
    id: `task_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    title: args.title,
    description: args.description || "",
    created_by: context.user_id,
    assignee: args.assignee || "",
    status: args.assignee ? "queued" : "draft",
    mode: normalizeCreatedTaskMode(args),
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
  state.tasks.push(task);
  state.activities.push({ time: now, type: "task.created", task_id: task.id, title: task.title });
  await store.save();
  if (isCodexSessionInventoryTaskKind(task)) return { task };
  const linked = await ensureTaskGoal(store, config, task.id, context, { assign_to_codex: Boolean(task.assignee) });
  return { task: linked.task, goal: linked.goal, conversation: linked.conversation, memories: linked.memories, workspace_files: linked.workspace_files };
}
