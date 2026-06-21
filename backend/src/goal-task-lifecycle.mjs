import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { defaultTokenContext, canAccessProject, canAccessWorkspace, requireProjectAccess, requireScope, requireWorkspaceAccess } from "./auth-context.mjs";
import { goalWorkspaceFiles, publicGoalWorkspaceFiles, internalGoalWorkspaceFiles, renderGoalMarkdown, renderTranscriptMarkdown, renderTranscriptMessageAppend, codexInstruction, safeBundleName } from "./goal-files.mjs";
import { isTaskTerminal, isCodexSessionInventoryTaskKind } from "./task-status.mjs";
import { ensureGoalState, findGoalInState, taskPayloadFromTask, normalizeLegacyModes, updateTask } from "./task-lifecycle.mjs";
import { titleFromGoal, normalizeGoalMessage, normalizeGoalMessages, normalizeGoalMemory, normalizeGoalMemories } from "./goal-lifecycle.mjs";
import { workspaceUploadBundleBase64, writeWorkspaceTextInternal } from "./workspace-service.mjs";
let createdTaskNotifier = null;

export function setCreatedTaskNotifier(fn) {
  createdTaskNotifier = fn;
}

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


export async function createGoal(store, config, args, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const projectId = args.project_id || "default";
  const workspaceId = args.workspace_id || "hosted-default";
  requireProjectAccess(context, projectId);
  requireWorkspaceAccess(context, workspaceId);

  const state = await store.load();
  ensureGoalState(state);
  const now = new Date().toISOString();
  const goalId = `goal_${randomUUID()}`;
  const conversationId = `conv_${randomUUID()}`;
  const assignToCodex = args.assign_to_codex !== false;
  const mode = normalizeCreatedTaskMode({ title: args.title || titleFromGoal(args), description: args.goal_prompt, mode: args.mode || "builder" });
  const messages = normalizeGoalMessages(args.messages, now, context.user_id);
  const memories = normalizeGoalMemories(args.memories, goalId, conversationId, now, context.user_id);
  const goal = {
    id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    task_id: null,
    user_request: String(args.user_request || ""),
    goal_prompt: String(args.goal_prompt || ""),
    context_summary: String(args.context_summary || ""),
    preview_text: String(args.preview_text || ""),
    title: args.title || titleFromGoal(args),
    created_by: context.user_id,
    assignee: assignToCodex ? "codex" : "",
    status: assignToCodex ? "assigned" : "open",
    mode,
    created_at: now,
    updated_at: now
  };

  // P0.1: Inject default autonomy/subagent policies if not provided in payload
  const payloadPolicies = args.payload || {};
  goal.autonomy_policy = payloadPolicies.autonomy_policy || {
    mode: 'subagent_first',
    gpt_question_budget: 0,
    allow_autonomous_defaults: true,
    default_decision_rule: 'choose_smallest_reversible_goal_aligned_change'
  };
  goal.subagent_policy = payloadPolicies.subagent_policy || {
    mode: 'optional',
    roles: ['analyst', 'architect', 'implementer', 'tester', 'reviewer', 'escalation_judge'],
    require_review_before_completion: false,
    require_test_or_verification: true
  };

  const conversation = {
    id: conversationId,
    goal_id: goalId,
    project_id: projectId,
    workspace_id: workspaceId,
    messages,
    created_at: now,
    updated_at: now
  };

  state.goals.push(goal);
  state.conversations.push(conversation);
  state.memories.push(...memories);
  state.activities.push({ time: now, type: "goal.created", goal_id: goalId, title: goal.title });

  let task = null;
  if (assignToCodex) {
    task = buildGoalTask(goal, conversation, context.user_id);
    state.tasks.push(task);
    goal.task_id = task.id;
    state.activities.push({ time: now, type: "goal.assigned_codex", goal_id: goalId, task_id: task.id, title: goal.title });
    if (!args.skip_created_notification) {
      createdTaskNotifier?.(task);
    }
  }

  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {
    payload: args.payload || null,
    payload_base64: args.payload_base64 || "",
    bundles: args.bundles || [],
    initialize_result: true
  }, context);
  await store.save();
  return { goal, conversation, memories, task, workspace_files };
}

export async function createEncodedGoal(store, config, { preview_text, payload_base64, assign_to_codex = true, wait_ms = 0 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "task:create");
  requireScope(context, "task:update");
  const payload = decodeBase64Json(payload_base64, "payload_base64");
  if (!payload.user_request || !payload.goal_prompt) throw new Error("encoded goal payload requires user_request and goal_prompt");
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  if (preview_text && !messages.some((message) => String(message.content || "") === String(preview_text))) {
    messages.push({ role: "chatgpt", content: String(preview_text) });
  }
  const created = await createGoal(store, config, {
    ...payload,
    messages,
    preview_text,
    payload,
    payload_base64,
    assign_to_codex: payload.assign_to_codex ?? assign_to_codex
  }, context);
  const execution = await waitForTaskExecution(store, created.task, wait_ms);
  return {
    ...created,
    workspace_files: publicGoalWorkspaceFiles(created.goal, payload),
    internal_files: internalGoalWorkspaceFiles(created.goal, payload),
    execution
  };
}

export async function listGoals(store, { status, assignee, workspace_id, limit = 50 } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);
  let goals = state.goals.filter((goal) => canAccessProject(context, goal.project_id) && canAccessWorkspace(context, goal.workspace_id));
  if (status) goals = goals.filter((goal) => goal.status === status);
  if (assignee) goals = goals.filter((goal) => goal.assignee === assignee);
  if (workspace_id) goals = goals.filter((goal) => goal.workspace_id === workspace_id);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  return { goals: goals.slice(-maxItems).reverse() };
}

export async function getGoalContext(store, config, { goal_id, task_id } = {}, context = defaultTokenContext("system")) {
  requireScope(context, "project:read");
  const state = await store.load();
  ensureGoalState(state);
  await normalizeLegacyModes(store, state);

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

  return { goal, conversation, memories, task, workspace_files: goalWorkspaceFiles(goal), codex_instruction: codexInstruction(goal) };
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

export async function writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, extras = {}, context = defaultTokenContext("system")) {
  const workspaceFiles = goalWorkspaceFiles(goal);
  const appendTranscript = extras.append_transcript === true;
  const skipPayload = extras.skip_payload === true;

  // Always write goal.md for compatibility
  const files = [
    { path: workspaceFiles.goal_md, content: renderGoalMarkdown(goal, conversation, memories, task, workspaceFiles) },
    { path: workspaceFiles.context_json, content: JSON.stringify({ goal, conversation, memories, task, workspace_files: workspaceFiles, codex_instruction: codexInstruction(goal) }, null, 2) },
  ];

  // Skip payload files during append-only operations (P0.2)
  if (!skipPayload) {
    const payload = extras.payload || {
      user_request: goal.user_request,
      goal_prompt: goal.goal_prompt,
      context_summary: goal.context_summary,
      mode: goal.mode,
      workspace_id: goal.workspace_id,
      messages: conversation?.messages || [],
      autonomy_policy: goal.autonomy_policy,
      subagent_policy: goal.subagent_policy,
      memories
    };
    const payloadJson = JSON.stringify(payload, null, 2);
    const payloadBase64 = extras.payload_base64 || Buffer.from(payloadJson, "utf8").toString("base64");
    files.push(
      { path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) },
      { path: workspaceFiles.payload_json, content: payloadJson },
      { path: workspaceFiles.payload_base64, content: payloadBase64 }
    );
  } else if (!appendTranscript) {
    // When !skipPayload and !appendTranscript, write transcript normally
    files.push({ path: workspaceFiles.transcript_md, content: renderTranscriptMarkdown(goal, conversation) });
  }
  // When appendTranscript && skipPayload, transcript is handled by caller via appendFile

  if (extras.initialize_result || typeof extras.result_content === "string") {
    files.push({ path: workspaceFiles.result_md, content: typeof extras.result_content === "string" ? extras.result_content : "# Result\n\nPending.\n" });
  }
  for (const file of files) {
    await writeWorkspaceTextInternal(store, config, goal.workspace_id, file.path, file.content, context);
  }
  for (const bundle of Array.isArray(extras.bundles) ? extras.bundles : []) {
    if (!bundle?.zip_base64) continue;
    const name = safeBundleName(bundle.name || `bundle-${randomUUID()}.zip`);
    const zipPath = `${workspaceFiles.attachments_dir}/${name}`;
    await workspaceUploadBundleBase64(store, config, { path: zipPath, zip_base64: bundle.zip_base64, overwrite: true, extract: true, target_dir: `${workspaceFiles.attachments_dir}/${name.replace(/\.zip$/i, "")}`, sha256_expected: bundle.sha256, workspace_id: goal.workspace_id }, context);
  }
  return workspaceFiles;
}

export function buildGoalTask(goal, conversation, createdBy) {
  const now = goal.created_at;
  return {
    id: `task_${randomUUID()}`,
    project_id: goal.project_id,
    workspace_id: goal.workspace_id,
    goal_id: goal.id,
    conversation_id: conversation.id,
    title: goal.title,
    description: [
      `Goal ID: ${goal.id}`,
      `Conversation ID: ${conversation.id}`,
      `Mode: ${goal.mode}`,
      "",
      "User Request:",
      goal.user_request,
      "",
      "Goal Prompt:",
      goal.goal_prompt,
      "",
      "Context Summary:",
      goal.context_summary || "(none)",
      "",
      "Before acting, call get_goal_context with this goal_id and append progress with append_goal_message."
    ].join("\n"),
    created_by: createdBy,
    assignee: "codex",
    status: "assigned",
    mode: goal.mode,
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
}


export function normalizeCreatedTaskMode(args) {
  const mode = String(args.mode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode && !allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
  if (mode === "readonly") {
    return isCodexSessionInventoryTaskKind({
      title: args.title,
      description: args.description || "",
      assignee: "codex",
      status: "assigned",
      mode: "readonly"
    }) ? "readonly" : "builder";
  }
  return mode || "builder";
}

export function normalizeAssignedTaskMode(task, requestedMode = "") {
  const mode = String(requestedMode || "").trim().toLowerCase();
  const allowedModes = new Set(["readonly", "builder", "deploy", "admin"]);
  if (mode) {
    if (!allowedModes.has(mode)) throw new Error(`unsupported task mode: ${mode}`);
    if (mode === "readonly" && !isCodexSessionInventoryTaskKind({ ...task, assignee: "codex", mode: "readonly" })) return "builder";
    return mode;
  }
  if (isCodexSessionInventoryTaskKind({ ...task, assignee: "codex" })) return "readonly";
  return task.mode && task.mode !== "readonly" ? task.mode : "builder";
}
