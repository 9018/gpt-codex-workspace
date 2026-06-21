import { isTaskTerminal } from "./task-status.mjs";

export function decodeTaskDescriptionEnvelope(description) {
  const text = String(description || "").trim();
  if (!text) return null;
  let envelope = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind === "gptwork.encoded_goal.v1" && parsed.payload_base64) envelope = parsed;
  } catch {}
  if (!envelope) {
    const match = text.match(/payload_base64\s*[:=]\s*([A-Za-z0-9+/=\r\n]+)/);
    if (match) envelope = { payload_base64: match[1].replace(/\s+/g, "") };
  }
  if (!envelope?.payload_base64) return null;
  const payload = decodeBase64Json(envelope.payload_base64, "task.description payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded task payload requires user_request and goal_prompt");
  return { payload, payload_base64: envelope.payload_base64, preview_text: envelope.preview_text || "" };
}

export function decodeBase64Json(value, label) {
  let decoded = "";
  try {
    decoded = Buffer.from(String(value || ""), "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

export async function waitForTaskExecution(store, task, waitMs = 0) {
  const boundedWaitMs = Math.max(0, Math.min(Number(waitMs) || 0, 300000));
  const deadline = Date.now() + boundedWaitMs;
  let snapshot = await taskExecutionSnapshot(store, task);
  while (boundedWaitMs > 0 && snapshot.task && !isTaskTerminal(snapshot.task) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(25, deadline - Date.now()))));
    snapshot = await taskExecutionSnapshot(store, task);
  }
  return snapshot;
}

export async function taskExecutionSnapshot(store, task) {
  const state = await store.load();
  const freshTask = task?.id
    ? (typeof store.findTaskById === "function" ? await store.findTaskById(task.id) : state.tasks.find((item) => item.id === task.id)) || task
    : null;
  const goal = freshTask?.goal_id
    ? (typeof store.findGoalById === "function" ? await store.findGoalById(freshTask.goal_id) : state.goals?.find((item) => item.id === freshTask.goal_id)) || null
    : freshTask?.id
      ? (typeof store.findGoalByTaskId === "function" ? store.findGoalByTaskId(freshTask.id) : state.goals?.find((item) => item.task_id === freshTask.id)) || null
      : null;
  const conversation = goal?.conversation_id
    ? (typeof store.findConversationById === "function" ? store.findConversationById(goal.conversation_id) : state.conversations?.find((item) => item.id === goal.conversation_id)) || null
    : null;
  const messages = conversation?.messages || [];
  return {
    status: freshTask?.status || goal?.status || "open",
    task: freshTask,
    goal_status: goal?.status || null,
    result: freshTask?.result || null,
    messages_tail: messages.slice(-5)
  };
}

// ---------------------------------------------------------------------------
// writeGoalWorkspaceFiles (P0.2: support append_transcript + skip_payload modes)
// ---------------------------------------------------------------------------
