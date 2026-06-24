import { updateTask } from '../task-lifecycle.mjs';
import { autoStartNextOnTaskCompleted } from '../goal-queue.mjs';
import { validateResultContract, DIAGNOSIS_CODES } from '../task-result-status.mjs';

/**
 * Factory for task completion and review MCP tool registration.
 * Dependencies are passed in to avoid circular imports from gptwork-server.mjs.
 */
export function createTaskCompletionToolsGroup({ tool, schema, store, github, eventLogger, hookBus }) {
  const common = { audience: ["chatgpt", "codex"], tags: ["task"], outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html" };
  return {
    complete_task: tool({
      name: "complete_task",
      description: "Mark a task completed with a summary of what was done. Use after Codex finishes the work and verification passes. Include a brief summary for ChatGPT review.",
      inputSchema: schema({ task_id: "string", summary: "string", admin_override: "boolean" }, ["task_id"]),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async ({ task_id, summary = "", admin_override = false }) => {
        let targetStatus = "completed";
        let resultFields = { summary, completed_at: new Date().toISOString() };

        // P0: Auto-accept when result exists and is contract-valid
        // Only escalate to review for actual contract violations or when no result exists
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
                // Check if the task already has a result with valid contract
                const existingResult = existingTask?.result;
                if (existingResult && existingResult.status === "completed") {
                  const contractValidation = validateResultContract(existingResult, { skipWorktreeCheck: true });
                  if (contractValidation.valid) {
                    // Auto-accept: result is contract-valid, no review needed
                    targetStatus = "completed";
                  } else {
                    // Contract violation: escalate to review with diagnosis codes
                    targetStatus = "waiting_for_review";
                    resultFields = {
                      summary: summary || "Task requires review: " + contractValidation.diagnosis_codes.join(", "),
                      completed_at: new Date().toISOString(),
                      policy_override_required: false,
                      diagnosis_codes: contractValidation.diagnosis_codes,
                      review_message: "Contract validation failed: " + contractValidation.warnings.join("; ") + ". Use admin_override=true to bypass."
                    };
                  }
                } else {
                  // No existing result — require policy validation
                  targetStatus = "waiting_for_review";
                  resultFields = {
                    summary: summary || "Task requires policy validation before completion",
                    completed_at: new Date().toISOString(),
                    policy_override_required: true,
                    review_message: "This task has a goal with required subagent policy. Use admin_override=true to bypass, or wait for Codex execution to validate autonomously."
                  };
                }
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
    }),
    request_human_review: tool({
      name: "request_human_review",
      description: "Mark a task as waiting for human review.",
      inputSchema: schema({ task_id: "string", message: "string" }, ["task_id"]),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async ({ task_id, message = "" }) => updateTask(store, task_id, (task) => { task.status = "waiting_for_review"; task.review_message = message; }),
    }),
  };
}
