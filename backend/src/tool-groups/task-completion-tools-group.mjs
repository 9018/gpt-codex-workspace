import { updateGoalStatus, updateTask, notifyTerminalTask } from '../task-lifecycle.mjs';
import { autoStartNextOnTaskCompleted } from '../goal-queue.mjs';
import { validateResultContract, DIAGNOSIS_CODES } from '../task-result-status.mjs';

import { createTaskTransitionService } from '../task-state/task-transition-service.mjs';
import { TASK_EVENTS } from '../task-state/task-transition-events.mjs';

function evidencePassed(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.passed === true || value.status === 'passed' || value.status === 'completed') return true;
  return value.contract_valid === true
    && value.blocking_passed === true
    && value.completion_eligible === true
    && value.requires_review !== true;
}

export function assessTaskCompletionReadiness(task = {}) {
  const contract = task.acceptance_contract || {};
  const strict = contract.acceptance_policy?.fail_on_missing_evidence === true;
  if (!strict) return { ready: true, strict: false, missing: [] };

  const result = task.result;
  const verification = task.verification || result?.verification;
  const contractVerification = task.contract_verification || result?.contract_verification;
  const missing = [];
  if (!result || result.status !== 'completed') missing.push('result');
  if (!evidencePassed(verification)) missing.push('verification');
  if (!evidencePassed(contractVerification)) missing.push('contract_verification');
  return { ready: missing.length === 0, strict: true, missing };
}

/**
 * Factory for task completion and review MCP tool registration.
 * Dependencies are passed in to avoid circular imports from gptwork-server.mjs.
 */
export function createTaskCompletionToolsGroup({ tool, schema, store, github, eventLogger, hookBus, transitionService: injectedTransitionService }) {
  const transitionService = injectedTransitionService || createTaskTransitionService({ store });
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
        let linkedGoalId = null;
        let canCompleteLinkedGoal = false;
        await store.load();
        const existingTask = typeof store.findTaskById === "function"
          ? await store.findTaskById(task_id)
          : (store.state?.tasks || []).find(t => t.id === task_id);
        if (existingTask?.status === "completed") {
          return { task: existingTask, idempotent_replay: true };
        }

        if (!admin_override) {
          try {
            const readiness = assessTaskCompletionReadiness(existingTask || {});
            if (readiness.ready && readiness.strict) {
              resultFields = {
                ...existingTask.result,
                summary: summary || existingTask.result?.summary || "",
                completed_at: new Date().toISOString(),
              };
            }
            if (!readiness.ready) {
              targetStatus = "waiting_for_review";
              resultFields = {
                ...(existingTask?.result && typeof existingTask.result === "object" ? existingTask.result : {}),
                summary: summary || "Task requires completion evidence before terminal transition",
                completion_requested_at: new Date().toISOString(),
                policy_override_required: true,
                diagnosis_codes: readiness.missing.map((item) => `missing_${item}`),
                review_message: `Completion blocked: missing ${readiness.missing.join(", ")}. Use admin_override=true only for an audited emergency override.`,
              };
            }

            if (existingTask?.goal_id) {
              linkedGoalId = existingTask.goal_id;
              const linkedGoal = typeof store.findGoalById === "function"
                ? await store.findGoalById(existingTask.goal_id)
                : (store.state?.goals || []).find(g => g.id === existingTask.goal_id);
              const subagent = linkedGoal?.subagent_policy || {};

              if (targetStatus === "completed" && subagent.mode === 'required') {
                // Check if the task already has a result with valid contract
                const existingResult = existingTask?.result;
                if (existingResult && existingResult.status === "completed") {
                  const contractValidation = validateResultContract(existingResult, { skipWorktreeCheck: true });
                  if (contractValidation.valid) {
                    // Auto-accept: result is contract-valid, no review needed
                    targetStatus = "completed";
                    canCompleteLinkedGoal = true;
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
          } catch (e) {
            targetStatus = "waiting_for_review";
            resultFields = {
              summary: summary || "Task completion readiness could not be verified",
              completion_requested_at: new Date().toISOString(),
              policy_override_required: true,
              diagnosis_codes: ["completion_readiness_check_failed"],
              review_message: `Completion readiness check failed closed: ${e?.message || String(e)}`,
            };
          }
        }

        if (admin_override) {
          resultFields.admin_override_used = true;
        }

        const summaryEvidence = String(summary || resultFields.summary || "").trim();
        if (admin_override || summaryEvidence) {
          canCompleteLinkedGoal = true;
        }

        const result = await transitionService.transitionTask({
          task_id,
          event: TASK_EVENTS.CANONICAL_DECISION_APPLIED,
          payload: {
            canonical_status: targetStatus,
            unified_decision: {
              status: targetStatus,
              source: admin_override ? "operator_admin_override" : "operator_completion_tool",
              requires_review: targetStatus === "waiting_for_review",
            },
            task_result_patch: resultFields,
          },
          reason: targetStatus === "completed"
            ? "complete_task accepted canonical evidence"
            : "complete_task blocked pending review",
          source: "operator",
          actor: { type: "operator", id: "complete_task" },
          idempotency_key: `complete_task:${task_id}:${targetStatus}:${resultFields.completed_at || resultFields.completion_requested_at || Date.now()}`,
        });

        // Preserve the terminal notification side effect that historically lived
        // in updateTask while keeping the status mutation inside the kernel.
        if (targetStatus === "completed") {
          const canonicalTask = typeof store.findTaskById === "function"
            ? await store.findTaskById(task_id)
            : ((await store.load()).tasks || []).find((task) => task.id === task_id);
          if (canonicalTask) {
            await notifyTerminalTask(canonicalTask);
            if (typeof store.save === "function") await store.save();
            result.task = canonicalTask;
          }
        }

        if (targetStatus === "completed" && result.task?.goal_id && canCompleteLinkedGoal) {
          const state = await store.load();
          const linkedGoal = typeof store.findGoalById === "function"
            ? await store.findGoalById(result.task.goal_id)
            : (state.goals || []).find((goal) => goal.id === result.task.goal_id);
          const terminalGoalStatuses = new Set(["completed", "failed", "blocked", "cancelled"]);
          if (linkedGoal && !terminalGoalStatuses.has(linkedGoal.status)) {
            await updateGoalStatus(store, linkedGoal.id, "completed");
          }
        }

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
      handler: async ({ task_id, message = "" }) => transitionService.transitionTask({
        task_id,
        event: TASK_EVENTS.CANONICAL_DECISION_APPLIED,
        payload: {
          canonical_status: "waiting_for_review",
          unified_decision: {
            status: "waiting_for_review",
            source: "operator_review_request",
            requires_review: true,
          },
          task_result_patch: { review_message: message },
        },
        reason: message || "human review requested",
        source: "operator",
        actor: { type: "operator", id: "request_human_review" },
        idempotency_key: `request_human_review:${task_id}:${Date.now()}`,
      }),
    }),
  };
}
