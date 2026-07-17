import {
  applyFailedAutoIntegrationCompletion,
  applySuccessfulAutoIntegrationCompletion,
  classifyIntegrationQueueResult,
} from "../auto-integration-completion.mjs";
import { applyRepairMetadata, taskWithRepairContext } from "../task-processing/task-repair-context.mjs";
import { sanitizeTaskBranchName } from "../task-worktree-manager.mjs";

export function classifyFinalizationIntegrationResult(integrationResult = {}) {
  return classifyIntegrationQueueResult(integrationResult);
}

export function applySuccessfulIntegrationCompletion({ taskResult = {}, integrationResult = {}, autoCompletion = {} } = {}) {
  return applySuccessfulAutoIntegrationCompletion({ taskResult, integrationResult, autoCompletion });
}

export function applyFailedIntegrationCompletion({ taskResult = {}, autoCompletion = {} } = {}) {
  return applyFailedAutoIntegrationCompletion({ taskResult, autoCompletion });
}

export async function finalizeWaitingForIntegration({
  taskStatus,
  taskResult = {},
  task,
  goal,
  store,
  config = {},
  resolvedRepo,
  runIntegrationQueueFn,
  runAutoIntegrationCompletionFn,
  shouldAttemptRepairFn,
  createRepairGoalFromFindingsFn,
  createGoalFn,
} = {}) {
  if (taskStatus !== "waiting_for_integration") return { taskStatus, taskResult };

  try {
    const gitPath = resolvedRepo?.task_worktree_path || resolvedRepo?.canonical_repo_path || null;
    if (!gitPath || !resolvedRepo?.repo_id) return { taskStatus, taskResult };

    const integrationResult = await runIntegrationQueueFn({
      repoId: resolvedRepo.repo_id,
      targetBranch: config.defaultBranch || "main",
      worktreePath: gitPath,
      canonicalRepoPath: resolvedRepo?.canonical_repo_path || null,
      taskBranch: resolvedRepo?.worktree_lifecycle?.branch_name || sanitizeTaskBranchName(task.id),
      integrationMode: config.integrationMode || "push_branch",
      checkCommands: config.integrationCheckCommands,
      locksBasePath: config.defaultWorkspaceRoot,
      taskId: task.id,
    });

    if (integrationResult.ok) {
      taskResult.integration = { ...integrationResult };
      const integrationDecision = classifyFinalizationIntegrationResult(integrationResult);
      if (integrationDecision.kind === "terminal_completed") {
        taskStatus = integrationDecision.task_status;
      } else if (integrationDecision.should_attempt_auto_completion) {
        const autoCompletion = await runAutoIntegrationCompletionFn({
          task,
          goal,
          taskResult,
          resolvedRepo,
          integrationResult,
          config,
        });
        taskResult.auto_integration_completion = autoCompletion;
        if (autoCompletion.completed === true) {
          taskStatus = "completed";
          taskResult = applySuccessfulIntegrationCompletion({ taskResult, integrationResult, autoCompletion });
        } else {
          taskStatus = "waiting_for_review";
          taskResult = applyFailedIntegrationCompletion({ taskResult, autoCompletion });
        }
      } else {
        taskStatus = integrationDecision.task_status;
      }
      return { taskStatus, taskResult };
    }

    if (classifyFinalizationIntegrationResult(integrationResult).should_attempt_repair) {
      const intCanRepair = await shouldAttemptRepairFn({
        task,
        tasks: store.state?.tasks || [],
        maxAttempts: config.maxRepairAttempts || task.max_attempts || 2,
      });
      if (intCanRepair.should_repair) {
        const intRepairGoal = await createRepairGoalFromFindingsFn({
          task: taskWithRepairContext(task, resolvedRepo),
          goal,
          findings: [{
            severity: "blocker",
            code: "integration_" + integrationResult.status,
            message: integrationResult.error || "Integration " + integrationResult.status,
            source: "integration_queue",
          }],
          repairProposals: [{
            title: "Resolve integration failure",
            proposed_action: "Fix integration " + integrationResult.status + " and rerun integration.",
          }],
        });
        taskStatus = "waiting_for_repair";
        taskResult.repair_goal = intRepairGoal;
        taskResult.repair_attempt = intRepairGoal.repair_attempt;
        taskResult.integration = {
          status: integrationResult.status,
          error: integrationResult.error,
          conflict_files: integrationResult.conflict_files,
        };
        try {
          const created = await createGoalFn(store, config, applyRepairMetadata({
            user_request: intRepairGoal.user_request,
            goal_prompt: intRepairGoal.goal_prompt,
            title: "Repair: " + task.title + " (integration conflict)",
            project_id: task.project_id || (goal ? goal.project_id : "default"),
            workspace_id: intRepairGoal.workspace_id || task.workspace_id || (goal ? goal.workspace_id : "hosted-default"),
            mode: intRepairGoal.mode || "full",
            assign_to_codex: true,
            skip_created_notification: false,
          }, intRepairGoal));
          taskResult.repair_goal_id = created.goal?.id || null;
          taskResult.repair_task_id = created.task?.id || null;
        } catch {}
      } else {
        taskStatus = "waiting_for_review";
        taskResult.repair_denied_reason = intCanRepair.reason;
        taskResult.integration = {
          status: integrationResult.status,
          error: integrationResult.error,
          conflict_files: integrationResult.conflict_files,
        };
      }
    } else {
      taskResult.integration = { status: integrationResult.status, error: integrationResult.error };
    }
  } catch (integrationErr) {
    taskResult.warnings = Array.isArray(taskResult.warnings) ? taskResult.warnings : [];
    taskResult.warnings.push("Integration queue execution failed: " + integrationErr.message);
  }

  return { taskStatus, taskResult };
}
