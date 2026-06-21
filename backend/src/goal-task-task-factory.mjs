import { randomUUID } from "node:crypto";
import { isCodexSessionInventoryTaskKind } from "./task-status.mjs";

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
