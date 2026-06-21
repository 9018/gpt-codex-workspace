/**
 * goal-task-lifecycle.mjs — compatibility facade for goal/task lifecycle helpers.
 */

export { setCreatedTaskNotifier } from "./goal-task-notifier.mjs";
export { createTask } from "./goal-task-creation.mjs";
export { createGoal, createEncodedGoal, listGoals } from "./goal-task-goals.mjs";
export { getGoalContext, appendGoalMessage } from "./goal-task-context.mjs";
export { ensureTaskGoal } from "./goal-task-ensure.mjs";
export { decodeTaskDescriptionEnvelope, decodeBase64Json, waitForTaskExecution, taskExecutionSnapshot } from "./goal-task-utils.mjs";
export { writeGoalWorkspaceFiles } from "./goal-task-workspace-files.mjs";
export { buildGoalTask, normalizeCreatedTaskMode, normalizeAssignedTaskMode } from "./goal-task-task-factory.mjs";
