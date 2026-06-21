import { defaultTokenContext } from "./auth-context.mjs";
import { isCodexSessionInventoryTaskKind } from "./task-status.mjs";
import { ensureGoalState, taskPayloadFromTask, updateTask } from "./task-lifecycle.mjs";
import { createGoal } from "./goal-task-goals.mjs";
import { decodeTaskDescriptionEnvelope } from "./goal-task-utils.mjs";
import { writeGoalWorkspaceFiles } from "./goal-task-workspace-files.mjs";

export async function ensureTaskGoal(store, config, taskId, context = defaultTokenContext("system"), options = {}) {
  const state = await store.load();
  ensureGoalState(state);
  const task = typeof store.findTaskById === "function"
    ? await store.findTaskById(taskId)
    : state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (isCodexSessionInventoryTaskKind(task)) return { task };

  let goal = task.goal_id
    ? (typeof store.findGoalById === "function" ? await store.findGoalById(task.goal_id) : state.goals.find((item) => item.id === task.goal_id))
    : (typeof store.findGoalByTaskId === "function" ? await store.findGoalByTaskId(taskId) : state.goals.find((item) => item.task_id === taskId));

  if (goal) {
    const conversation = typeof store.findConversationById === "function"
      ? store.findConversationById(goal.conversation_id)
      : state.conversations.find((item) => item.id === goal.conversation_id) || null;
    const memories = typeof store.getMemoriesByGoalId === "function"
      ? store.getMemoriesByGoalId(goal.id)
      : state.memories.filter((item) => item.goal_id === goal.id);
    const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {}, context);
    return { task, goal, conversation, memories, workspace_files };
  }

  const encoded = decodeTaskDescriptionEnvelope(task.description || "");
  const payload = encoded?.payload || taskPayloadFromTask(task);
  const created = await createGoal(store, config, {
    ...payload,
    title: payload.title || task.title,
    project_id: payload.project_id || task.project_id,
    workspace_id: payload.workspace_id || task.workspace_id,
    mode: payload.mode || task.mode || "builder",
    assign_to_codex: options.assign_to_codex ?? task.assignee === "codex",
    skip_created_notification: true,
    preview_text: encoded?.preview_text || payload.preview_text || "",
    payload: encoded?.payload || payload,
    payload_base64: encoded?.payload_base64 || ""
  }, context);

  await updateTask(store, task.id, (item) => {
    item.goal_id = created.goal.id;
    item.conversation_id = created.conversation.id;
    if (created.task && created.task.id !== item.id) {
      created.goal.task_id = item.id;
    }
  });

  const linkedState = await store.load();
  const createdTask = created.task && created.task.id !== task.id ? created.task : null;
  if (createdTask) {
    const index = linkedState.tasks.findIndex((item) => item.id === createdTask.id);
    if (index !== -1) linkedState.tasks.splice(index, 1);
  }
  goal = linkedState.goals.find((item) => item.id === created.goal.id);
  goal.task_id = task.id;
  const linkedTask = linkedState.tasks.find((item) => item.id === task.id);
  const conversation = linkedState.conversations.find((item) => item.id === goal.conversation_id) || null;
  const memories = linkedState.memories.filter((item) => item.goal_id === goal.id);
  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, linkedTask, {}, context);
  await store.save();
  return { task: linkedTask, goal, conversation, memories, workspace_files };
}
