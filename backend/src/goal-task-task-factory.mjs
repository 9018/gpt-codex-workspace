import { randomUUID } from "node:crypto";
import { TASK_STATUSES } from "./task-status-taxonomy.mjs";
import { isCodexSessionInventoryTaskKind } from "./task-status.mjs";
import { WORKSTREAM_IDENTITY_FIELDS } from "./workstream/workstream-model.mjs";

// ---------------------------------------------------------------------------
// Active task statuses — any task in one of these statuses is considered
// "in progress" and prevents duplicate task creation for the same goal.
// ---------------------------------------------------------------------------
const ACTIVE_TASK_STATUSES = new Set([
  TASK_STATUSES.ASSIGNED,
  TASK_STATUSES.QUEUED,
  TASK_STATUSES.RUNNING,
  TASK_STATUSES.WAITING_FOR_LOCK,
  TASK_STATUSES.WAITING_FOR_REVIEW,
  TASK_STATUSES.WAITING_FOR_REPAIR,
  TASK_STATUSES.WAITING_FOR_INTEGRATION,
]);

export function defaultTaskExecutionFields(mode = "builder") {
  const isOrdinaryCodeTask = mode === "builder";
  return {
    execution_mode: isOrdinaryCodeTask ? "worktree" : "canonical",
    worktree: isOrdinaryCodeTask ? {
      enabled: true,
      path: null,
      branch: null,
      base_ref: null,
      base_sha: null,
      head_sha: null,
      status: "pending",
    } : {
      enabled: false,
      path: null,
      branch: null,
      base_ref: null,
      base_sha: null,
      head_sha: null,
      status: "disabled",
    },
    attempt: 0,
    max_attempts: 2,
  };
}

export function buildGoalTask(goal, conversation, createdBy) {
  const now = goal.created_at;
  const mode = goal.mode || "builder";
  const task = {
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
    require_pipeline_gates: ["builder", "deploy", "admin"].includes(mode),
    assignee: "codex",
    status: "assigned",
    mode,
    ...defaultTaskExecutionFields(mode),
    logs: [],
    artifacts: [],
    result: null,
    created_at: now,
    updated_at: now
  };
  for (const key of [
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
  ]) {
    if (goal[key] !== undefined) task[key] = goal[key];
  }
  for (const key of WORKSTREAM_IDENTITY_FIELDS) {
    if (goal[key] !== undefined) task[key] = goal[key];
  }
  return task;
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

/**
 * Create a Codex task for a given goal and persist it to state.
 *
 * Designed to be called from goal-queue.mjs startNextQueuedGoal() so that
 * queue items can be promoted from waiting/ready to running with a real task.
 *
 * This function:
 * 1. Loads the goal and its associated conversation from state.
 * 2. Checks if the goal already has an active task — if so, returns it
 *    instead of creating a duplicate (P0 fix: prevent duplicate task creation).
 * 3. Calls buildGoalTask() to construct the task object.
 * 4. Pushes the task into state.tasks and links goal.task_id to task.id.
 * 5. Persists the mutation atomically via store.mutate().
 *
 * @param {object} store   - StateStore instance.
 * @param {object} config  - Server config (needed for workspaceFiles).
 * @param {string} goalId  - ID of the goal to create a task for.
 * @param {object} [opts]  - Optional overrides.
 * @param {string} [opts.assignee='codex']  - Task assignee.
 * @param {string} [opts.status='assigned'] - Initial task status.
 * @param {string} [opts.mode='builder']    - Task mode.
 * @returns {Promise<object>} The created (or existing) task object.
 */
export async function createGoalTask(store, config, goalId, opts = {}) {
  // Use store.mutate for atomic read-write
  const result = await store.mutate((state) => {
    // Find the goal
    const goal = (state.goals || []).find((g) => g.id === goalId);
    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    // P0 fix: Prevent duplicate task creation — if the goal already has
    // an active task, return the existing task instead of creating a new one.
    // This handles the case where create_goal(assign_to_codex=true) already
    // created a task, and then enqueueGoal -> startNextQueuedGoal tries to
    // create another one.
    state.tasks = state.tasks || [];
    if (goal.task_id) {
      const existingTask = state.tasks.find((t) => t.id === goal.task_id);
      if (existingTask && ACTIVE_TASK_STATUSES.has(existingTask.status)) {
        // Goal already has an active task — return it instead of creating duplicate
        return { task: existingTask, reused: true, warnings: [`Goal ${goalId} already has active task ${existingTask.id} (status=${existingTask.status}); reusing instead of creating duplicate`] };
      }
      if (existingTask && existingTask.status === "completed") {
        // Task completed — allow creating a new one
        // (this is a new execution cycle for an existing goal)
      }
    }

    // Find the conversation
    const convId = goal.conversation_id;
    const conversation = (state.conversations || []).find((c) => c.id === convId);
    if (!conversation) {
      throw new Error(`Conversation not found for goal ${goalId}: ${convId}`);
    }

    const assignee = opts.assignee || 'codex';
    const createdBy = opts.created_by || 'system';
    const task = buildGoalTask(goal, conversation, createdBy);

    // Apply overrides
    task.assignee = assignee;
    task.status = opts.status || 'assigned';
    task.mode = opts.mode || task.mode || 'builder';
    Object.assign(task, defaultTaskExecutionFields(task.mode));
    task.updated_at = new Date().toISOString();

    state.tasks.push(task);
    goal.task_id = task.id;

    return { task, reused: false, warnings: [] };
  });
  return result.task;
}
