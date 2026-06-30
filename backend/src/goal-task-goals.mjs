import { randomUUID } from "node:crypto";
import { defaultTokenContext, canAccessProject, canAccessWorkspace, requireProjectAccess, requireScope, requireWorkspaceAccess } from "./auth-context.mjs";
import { publicGoalWorkspaceFiles, internalGoalWorkspaceFiles } from "./goal-files.mjs";
import { ensureGoalState, normalizeLegacyModes } from "./task-lifecycle.mjs";
import { titleFromGoal, normalizeGoalMessages, normalizeGoalMemories } from "./goal-lifecycle.mjs";
import { buildGoalTask, normalizeCreatedTaskMode } from "./goal-task-task-factory.mjs";
import { writeGoalWorkspaceFiles } from "./goal-task-workspace-files.mjs";
import { decodeBase64Json, waitForTaskExecution } from "./goal-task-utils.mjs";
import { notifyCreatedTask } from "./goal-task-notifier.mjs";
import { buildAcceptanceContract } from "./acceptance/contract-builder.mjs";
import { ensureWorkflowRun } from "./workflow-run-store.mjs";

const REPAIR_METADATA_KEYS = [
  "root_task_id",
  "parent_task_id",
  "attempt",
  "repair_of_attempt",
  "failure_class",
  "repair_attempt",
  "max_attempts",
  "repair_of_goal_id",
  "repair_of_task_id",
  "repair_of_worktree",
  "repair_of_branch",
];

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
  const acceptanceContract = buildAcceptanceContract({ ...args, mode });
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
    acceptance_contract: acceptanceContract,
    created_at: now,
    updated_at: now
  };
  for (const key of REPAIR_METADATA_KEYS) {
    if (args[key] !== undefined) goal[key] = args[key];
  }

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
      notifyCreatedTask(task);
    }
  }

  const workspace_files = await writeGoalWorkspaceFiles(store, config, goal, conversation, memories, task, {
    payload: args.payload || null,
    payload_base64: args.payload_base64 || "",
    bundles: args.bundles || [],
    initialize_result: true
  }, context);
  await store.save();
  if (task && !args.skip_workflow_run && config?.defaultWorkspaceRoot) {
    ensureWorkflowRun(config.defaultWorkspaceRoot, {
      workflow_id: "default",
      goal_id: goal.id,
      task_id: task.id,
      current_step: "goal_created",
      status: "queued",
      refs: { source: "create_goal", conversation_id: conversation.id },
    });
  }
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
