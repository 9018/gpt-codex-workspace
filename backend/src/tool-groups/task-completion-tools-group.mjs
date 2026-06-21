import { updateTask } from '../task-lifecycle.mjs';

/**
 * Factory for task completion and review MCP tool registration.
 * Dependencies are passed in to avoid circular imports from gptwork-server.mjs.
 */
export function createTaskCompletionToolsGroup({ tool, schema, store, github, eventLogger, hookBus }) {
  return {
    complete_task: tool(
      "Mark a task completed with a summary of what was done. Use after Codex finishes the work and verification passes. Include a brief summary for ChatGPT review.",
      schema({ task_id: "string", summary: "string", admin_override: "boolean" }, ["task_id"]),
      async ({ task_id, summary = "", admin_override = false }) => {
        let targetStatus = "completed";
        let resultFields = { summary, completed_at: new Date().toISOString() };

        if (!admin_override) {
          try {
            await store.load();
            const existingTask = typeof store.findTaskById === "function"
              ? await store.findTaskById(task_id)
              : (store.state?.tasks || []).find(t => t.id === task_id);
            if (existingTask?.goal_id) {
              const linkedGoal = typeof store.findGoalById === "function"
                ? await store.findGoalById(existingTask.goal_id)
                : (store.state?.goals || []).find(g => g.id === existingTask.goal_id);
              const subagent = linkedGoal?.subagent_policy || {};
              if (subagent.mode === 'required') {
                targetStatus = "waiting_for_review";
                resultFields = {
                  summary: summary || "Task requires policy validation before completion",
                  completed_at: new Date().toISOString(),
                  policy_override_required: true,
                  review_message: "This task has a goal with required subagent policy. Use admin_override=true to bypass, or wait for Codex execution to validate autonomously."
                };
              }
            }
          } catch (e) { /* non-fatal: proceed with normal completion */ }
        }

        if (admin_override) {
          resultFields.admin_override_used = true;
        }

        const result = await updateTask(store, task_id, (task) => {
          task.status = targetStatus;
          task.result = resultFields;
        });
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.completed", { task_id, status: targetStatus, summary });
        await hookBus?.emit("onTaskCompleted", { task: result.task });
        return result;
      },
    ),
    request_human_review: tool(
      "Mark a task as waiting for human review.",
      schema({ task_id: "string", message: "string" }, ["task_id"]),
      async ({ task_id, message = "" }) => updateTask(store, task_id, (task) => { task.status = "waiting_for_review"; task.review_message = message; }),
    ),
  };
}
