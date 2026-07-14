import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { defaultTokenContext, requireProjectAccess, requireScope, requireWorkspaceAccess } from "./auth-context.mjs";
import { goalWorkspaceFiles, renderTranscriptMarkdown, renderTranscriptMessageAppend, codexInstruction } from "./goal-files.mjs";
import { ensureGoalState, findGoalInState } from "./task-lifecycle.mjs";
import { normalizeGoalMessage, normalizeGoalMemory } from "./goal-lifecycle.mjs";
import { writeWorkspaceTextInternal } from "./workspace-service.mjs";
import { writeGoalWorkspaceFiles } from "./goal-task-workspace-files.mjs";
import { normalizeLegacyGoalWorkstream, normalizeLegacyTaskWorkstream } from "./workstream/workstream-model.mjs";

export async function getGoalContext(store, config, { goal_id, task_id } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);

  // Use indexed lookups when available
  let goal = null;
  if (goal_id && typeof store.findGoalById === "function") {
    goal = await store.findGoalById(goal_id);
  }
  if (!goal && task_id && typeof store.findGoalByTaskId === "function") {
    goal = await store.findGoalByTaskId(task_id);
  }
  if (!goal) {
    goal = findGoalInState(state, { goal_id, task_id });
  }
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);

  const conversation = typeof store.findConversationById === "function"
    ? store.findConversationById(goal.conversation_id)
    : state.conversations.find((item) => item.id === goal.conversation_id) || null;

  const memories = typeof store.getMemoriesByGoalId === "function"
    ? store.getMemoriesByGoalId(goal.id)
    : state.memories.filter((item) => item.goal_id === goal.id);

  const task = goal.task_id
    ? (typeof store.findTaskById === "function"
        ? await store.findTaskById(goal.task_id)
        : state.tasks.find((item) => item.id === goal.task_id)) || null
    : null;

  const normalizedGoal = goal.mode === "full" ? goal : { ...goal, legacy_mode: goal.legacy_mode || goal.mode || null, mode: "full" };
  const goalView = normalizeLegacyGoalWorkstream(normalizedGoal);
  const normalizedTask = task && task.mode !== "full" ? { ...task, legacy_mode: task.legacy_mode || task.mode || null, mode: "full" } : task;
  const taskView = normalizedTask ? normalizeLegacyTaskWorkstream(normalizedTask, goalView) : null;
  return {
    goal: goalView,
    conversation,
    memories,
    task: taskView,
    workspace_files: goalWorkspaceFiles(goal),
    codex_instruction: codexInstruction(goal),
  };
}

// ---------------------------------------------------------------------------
// Append-only goal message (P0.2)
// ---------------------------------------------------------------------------

export async function appendGoalMessage(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:update");
  const state = await store.load();
  ensureGoalState(state);

  // Use indexed goal lookup when available
  let goal = null;
  if (args.goal_id && typeof store.findGoalById === "function") {
    goal = await store.findGoalById(args.goal_id);
  }
  if (!goal && args.task_id && typeof store.findGoalByTaskId === "function") {
    goal = await store.findGoalByTaskId(args.task_id);
  }
  if (!goal) {
    goal = findGoalInState(state, args);
  }
  requireProjectAccess(context, goal.project_id);
  requireWorkspaceAccess(context, goal.workspace_id);

  let conversation = typeof store.findConversationById === "function"
    ? store.findConversationById(goal.conversation_id)
    : state.conversations.find((item) => item.id === goal.conversation_id);

  const now = new Date().toISOString();
  if (!conversation) {
    conversation = {
      id: goal.conversation_id || `conv_${randomUUID()}`,
      goal_id: goal.id,
      project_id: goal.project_id,
      workspace_id: goal.workspace_id,
      messages: [],
      created_at: now,
      updated_at: now
    };
    goal.conversation_id = conversation.id;
    state.conversations.push(conversation);
  }
  conversation.messages ||= [];
  const message = normalizeGoalMessage({ role: args.role || "codex", content: args.content }, now, context.user_id);
  conversation.messages.push(message);
  conversation.updated_at = now;
  goal.updated_at = now;
  let memory = null;
  if (args.memory_key || args.memory_value) {
    memory = normalizeGoalMemory({ key: args.memory_key || "note", value: args.memory_value || args.content }, goal.id, conversation.id, now, context.user_id);
    state.memories.push(memory);
  }
  state.activities.push({ time: now, type: "goal.message_appended", goal_id: goal.id, role: message.role });

  const memories = typeof store.getMemoriesByGoalId === "function"
    ? store.getMemoriesByGoalId(goal.id)
    : state.memories.filter((item) => item.goal_id === goal.id);

  const task = goal.task_id
    ? (typeof store.findTaskById === "function"
        ? await store.findTaskById(goal.task_id)
        : state.tasks.find((item) => item.id === goal.task_id)) || null
    : null;

  // Append-only write: only append to transcript, rewrite goal.md + context.json,
  // skip payload_base64 and payload.json regeneration
  const workspaceFiles = goalWorkspaceFiles(goal);
  await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {
    initialize_result: false,
    append_transcript: true,
    skip_payload: true
  }, context);

  // Append the new message to transcript.md separately (append-only)
  try {
    const resolvedPath = await _resolveWorkspacePathForFile(store, config, goal.workspace_id, workspaceFiles.transcript_md, context);
    await appendFile(resolvedPath, renderTranscriptMessageAppend(message), "utf8");
  } catch {
    // Fallback: full rewrite if append fails (e.g. file doesn't exist yet)
    const transcriptContent = renderTranscriptMarkdown(goal, conversation);
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, workspaceFiles.transcript_md, transcriptContent, context);
  }

  await store.save();
  return { goal, conversation, message, memory, workspace_files: workspaceFiles };
}

// Internal helper: resolve workspace path for append-only operations
async function _resolveWorkspacePathForFile(store, config, workspaceId, relPath, context) {
  const { resolvePath } = await import("./workspace-service.mjs");
  const { path: resolvedPath } = await resolvePath(store, config, { path: relPath, workspace_id: workspaceId }, context);
  return resolvedPath;
}
