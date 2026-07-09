/**
 * repair-loop.mjs — Automatic repair loop for failed acceptance tasks.
 *
 * Creates repair tasks from acceptance findings, tracks repair attempts,
 * and manages the repair lifecycle.
 */
import { writeRepairerAgentRun } from "./agent-run-writeback.mjs";

import { randomUUID } from 'node:crypto';
import { createGoal } from './goal-task-goals.mjs';

function tail(value, max = 4000) {
  return String(value || '').slice(-max);
}

function failedCommands(verification = {}) {
  return Array.isArray(verification.commands)
    ? verification.commands.filter((command) => Number(command?.exit_code) !== 0)
    : [];
}

function formatCommand(command = {}) {
  const lines = [
    `Command: ${command.cmd || command.command || '(unknown)'}`,
    `Exit code: ${command.exit_code ?? '(unknown)'}`,
  ];
  if (command.stdout_tail || command.stdout) lines.push(`stdout tail:\n${tail(command.stdout_tail ?? command.stdout)}`);
  if (command.stderr_tail || command.stderr) lines.push(`stderr tail:\n${tail(command.stderr_tail ?? command.stderr)}`);
  return lines.join('\n');
}

function repairInstructionsForFailure(failure = {}) {
  switch (failure.failure_class) {
    case 'missing_result_json':
    case 'invalid_result_json':
      return [
        'Repair finalizer/result-json output only.',
        'Do not rewrite unrelated business code.',
        'Inspect why result.json/result.md was missing or invalid, then write a valid result.json using the requested contract.',
        'Keep changes focused on result reporting unless a tiny finalizer fix is required to produce valid output.',
      ];
    case 'git_diff_check_failed':
      return ['Fix whitespace/conflict-marker formatting reported by git diff --check, then rerun verification.'];
    case 'build_failed':
    case 'lint_failed':
    case 'typecheck_failed':
    case 'test_failed':
      return ['Fix the failing verification command using the smallest goal-aligned change, then rerun the failed command and any related checks.'];
    case 'no_first_output_timeout':
      return ['Repair the finalization/reporting path so the task can make first progress and produce result.json safely.'];
    // ---- P0-C7: Repair instructions for new failure classes ----
    case 'execution_failed':
      return ['Codex execution failed. Re-run with adjusted parameters, enriched context, and corrective hints from the previous execution output.'];
    case 'result_contract_invalid':
      return ['Repair the result contract. Inspect why the result.json/result.md fails contract validation, then produce a valid result using the required contract format. Do not rewrite unrelated business code.'];
    case 'verification_failed':
      return ['Fix the verification failure using the smallest goal-aligned change, then rerun all verification commands.'];
    case 'acceptance_failed':
      return ['Acceptance criteria not met. Review the acceptance findings and fix the gaps. Keep changes scoped to the original goal. Re-run verification after fixing.'];
    case 'integration_failed':
      return ['Integration step failed (conflict, push, or PR failure). Resolve the integration issue and retry. If this is a merge conflict, resolve it manually.'];
    case 'context_missing':
      return ['Required context is missing. Re-run with enriched context from the original task evidence chain. Preserve all original evidence in the repair prompt.'];
    case 'deployment_failed':
    case 'repair_budget_exhausted':
      return ['This failure is non-repairable. Route to human interrupt for terminal decision.'];
    default:
      return ['Investigate the classified failure and make the smallest goal-aligned repair.'];
  }
}

export function buildRepairPrompt({ task = {}, goal = {}, failure = {}, verification = {}, diff = '', logs = '' } = {}) {
  const failed = failedCommands(verification);
  const findings = Array.isArray(verification.findings) ? verification.findings : [];
  return [
    `# Repair Task: ${task.title || task.id || 'Codex task'}`,
    '',
    `failure_class: ${failure.failure_class || 'unknown'}`,
    `repair_strategy: ${failure.repair_strategy || 'manual_review'}`,
    `reason: ${failure.reason || 'No reason recorded.'}`,
    `attempt: ${(Number.isInteger(task.attempt) ? task.attempt : Number(task.repair_attempt || 0)) + 1}`,
    `repair_of_attempt: ${Number.isInteger(task.attempt) ? task.attempt : Number(task.repair_attempt || 0)}`,
    '',
    '## Original Goal',
    goal.goal_prompt || goal.user_request || task.description || '(original goal not available)',
    '',
    '## Previous Attempt Summary',
    task.result?.summary || '(no previous result summary available)',
    '',
    '## Targeted Repair Instructions',
    ...repairInstructionsForFailure(failure).map((line) => `- ${line}`),
    '- Preserve the original scope and constraints.',
    '- Report the result using the standard result.json contract.',
    '',
    '## Failed Commands',
    ...(failed.length > 0 ? failed.map((command, index) => `${index + 1}. ${formatCommand(command)}`) : ['(no failed commands recorded)']),
    '',
    '## Verification Findings',
    ...(findings.length > 0 ? findings.map((finding, index) => `${index + 1}. [${finding.severity || 'unknown'}] ${finding.code || 'unknown'}: ${finding.message || ''}`) : ['(no findings recorded)']),
    '',
    '## Diff Tail',
    tail(diff) || '(no diff provided)',
    '',
    '## Log Tail',
    tail(logs) || '(no logs provided)',
    '',
  ].join('\n');
}

/**
 * Create a repair goal from acceptance findings.
 *
 * @param {object} options
 * @param {object} options.task - Original task that failed acceptance
 * @param {object} options.goal - Original goal
 * @param {Array} options.findings - Acceptance findings
 * @param {Array} options.repairProposals - Repair proposals from acceptance agent
 * @returns {object} Repair goal descriptor
 */
export function createRepairGoalFromFindings({ task, goal, findings, repairProposals } = {}) {
  const rootTaskId = task.root_task_id || task.id;
  const previousAttempt = Number.isInteger(task.attempt) ? task.attempt : Number(task.repair_attempt || 0);
  const attempt = previousAttempt + 1;
  const maxAttempts = task.max_attempts || task.maxAttempts || Number.parseInt(process.env.GPTWORK_MAX_REPAIR_ATTEMPTS || '2', 10);
  const repairOfWorktree = task.repair_of_worktree
    || task.worktree_path
    || task.worktree?.path
    || task.result?.repo_resolution?.task_worktree_path
    || task.result?.worktree_lifecycle?.worktree_path
    || null;
  const repairOfBranch = task.repair_of_branch
    || task.worktree?.branch
    || task.result?.worktree_lifecycle?.branch_name
    || task.result?.repo_resolution?.worktree_lifecycle?.branch_name
    || null;

  const repairPrompt = [
    `# Repair Task: ${task.title}`,
    '',
    `This is repair attempt ${attempt} for root task ${rootTaskId}.`,
    '',
    '## Original Goal',
    goal?.goal_prompt || goal?.user_request || task.description || '(original goal not available)',
    '',
    '## What Was Changed (Previous Attempt Summary)',
    task.result?.summary || '(no previous result summary available)',
    '',
    '## Original Failure Context',
    `Original failure goal: ${goal?.id || task.goal_id || '(unknown)'}`,
    `Original failure task: ${task.id || '(unknown)'}`,
    `Original failure worktree: ${repairOfWorktree || '(not recorded)'}`,
    `Original failure branch: ${repairOfBranch || '(not recorded)'}`,
    '',
    '## Acceptance Findings That Need Repair',
    ...(Array.isArray(findings) ? findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.code}: ${f.message}`) : ['(no findings)']),
    '',
    '## Required Repairs',
    ...(Array.isArray(repairProposals) ? repairProposals.map((p, i) => `${i + 1}. ${p.proposed_action || p.title}`) : ['Fix all issues identified above.']),
    '',
    '## Constraints',
    '- Do NOT expand scope beyond the original goal.',
    '- Re-run all verification commands after making changes.',
    '- Write result.json with the standard contract.',
    '',
  ].join('\n');

  return {
    id: `repair_${rootTaskId}_${attempt}`,
    parent_task_id: task.id,
    root_task_id: rootTaskId,
    attempt,
    repair_of_attempt: previousAttempt,
    failure_class: task.failure_class || task.result?.failure_class || findings?.[0]?.code || null,
    repair_attempt: attempt,
    max_attempts: maxAttempts,
    repair_of_goal_id: goal?.id || task.goal_id || null,
    repair_of_task_id: task.id || null,
    repair_of_worktree: repairOfWorktree,
    repair_of_branch: repairOfBranch,
    reason: findings?.[0]?.message || 'acceptance_failure',
    acceptance_findings: findings || [],
    repair_proposals: repairProposals || [],
    goal_prompt: repairPrompt,
    user_request: `Repair: ${task.title} (attempt ${attempt})`,
    mode: task.mode || 'builder',
    workspace_id: task.workspace_id || goal?.workspace_id,
    repo_id: task.repo_id || goal?.repo_id,
    // ---- P0-C7: Repair tracking fields ----
    repair_budget: task.repair_budget ?? task.max_attempts ?? task.maxAttempts ?? maxAttempts,
    superseded_by_task_id: task.superseded_by_task_id || null,
    resolved_by_task_id: task.resolved_by_task_id || null,
  };
}

export async function scheduleRepairAttempt({ store, task = {}, goal = {}, failure = {}, verification = {}, config = {}, diff = '', logs = '' } = {}) {
  const previousAttempt = Number.isInteger(task.attempt) ? task.attempt : Number(task.repair_attempt || 0);
  const attempt = previousAttempt + 1;
  const maxAttempts = Number.isInteger(task.max_attempts) ? task.max_attempts : Number(task.maxAttempts || config.maxRepairAttempts || 2);
  const repairPrompt = buildRepairPrompt({ task, goal, failure, verification, diff, logs });
  const findings = Array.isArray(verification.findings) && verification.findings.length > 0
    ? verification.findings
    : [{ severity: 'blocker', code: failure.failure_class || 'unknown', message: failure.reason || 'Task verification failed', source: 'failure_classifier' }];
  const repairGoal = createRepairGoalFromFindings({
    task: {
      ...task,
      attempt: previousAttempt,
      repair_attempt: previousAttempt,
      failure_class: failure.failure_class || task.failure_class || task.result?.failure_class || null,
    },
    goal,
    findings,
    repairProposals: [{ title: `Repair ${failure.failure_class || 'task failure'}`, proposed_action: failure.reason || 'Fix classified task failure and rerun verification.' }],
  });

  repairGoal.goal_prompt = repairPrompt;
  repairGoal.user_request = `Repair: ${task.title || task.id} (attempt ${attempt})`;
  repairGoal.attempt = attempt;
  repairGoal.repair_of_attempt = previousAttempt;
  repairGoal.failure_class = failure.failure_class || 'unknown';
  repairGoal.max_attempts = maxAttempts;

  const payload = {
    user_request: repairGoal.user_request,
    goal_prompt: repairGoal.goal_prompt,
    title: `Repair: ${task.title || task.id} (attempt ${attempt})`,
    project_id: task.project_id || goal.project_id || 'default',
    workspace_id: repairGoal.workspace_id || task.workspace_id || goal.workspace_id || 'hosted-default',
    mode: repairGoal.mode || task.mode || 'builder',
    assign_to_codex: true,
    skip_created_notification: false,
    root_task_id: repairGoal.root_task_id,
    parent_task_id: repairGoal.parent_task_id,
    repair_attempt: repairGoal.repair_attempt,
    max_attempts: repairGoal.max_attempts,
    repair_of_goal_id: repairGoal.repair_of_goal_id,
    repair_of_task_id: repairGoal.repair_of_task_id,
    repair_of_worktree: repairGoal.repair_of_worktree,
    repair_of_branch: repairGoal.repair_of_branch,
    attempt,
    repair_of_attempt: previousAttempt,
    failure_class: repairGoal.failure_class,
    // ---- P0-C7: Repair tracking fields in payload ----
    repair_budget: repairGoal.repair_budget,
    superseded_by_task_id: repairGoal.superseded_by_task_id || null,
    resolved_by_task_id: repairGoal.resolved_by_task_id || null,
  };

  const createGoalFn = config.createGoalFn || createGoal;
  const created = await createGoalFn(store, config, payload);
  return {
    scheduled: true,
    attempt,
    repair_of_attempt: previousAttempt,
    failure_class: repairGoal.failure_class,
    repair_goal: repairGoal,
    repair_goal_id: created?.goal?.id || null,
    repair_task_id: created?.task?.id || null,
    created,
  };
}

/**
 * Determine if a repair attempt should be made based on max attempts config.
 *
 * @param {object} options
 * @param {object} options.task - Task with repair metadata
 * @param {number} [options.maxAttempts] - Max repair attempts (default from env or 2)
 * @returns {{ should_repair: boolean, reason: string }}
 */
export function shouldAttemptRepair({ task = {}, tasks = [], maxAttempts } = {}) {
  return shouldAttemptRepairWithLineage({ task, tasks, maxAttempts });
}

export function shouldAttemptRepairWithLineage({ task = {}, tasks = [], maxAttempts } = {}) {
  const max = maxAttempts != null ? maxAttempts : (parseInt(process.env.GPTWORK_MAX_REPAIR_ATTEMPTS || '2', 10));
  const rootTaskId = task.root_task_id || task.id;
  const lineageAttempts = Array.isArray(tasks)
    ? tasks
        .filter((candidate) => {
          const candidateRoot = candidate.root_task_id || candidate.id;
          return rootTaskId && candidateRoot === rootTaskId;
        })
        .map((candidate) => Number(candidate.repair_attempt || 0))
    : [];
  const attempt = Math.max(Number(task.repair_attempt || 0), ...lineageAttempts, 0);

  if (attempt >= max) {
    return {
      should_repair: false,
      reason: `Repair attempt ${attempt + 1} exceeds max ${max}. Waiting for review.`,
      current_attempt: attempt,
      max_attempts: max,
    };
  }

  return {
    should_repair: true,
    reason: `Repair attempt ${attempt + 1}/${max}`,
    current_attempt: attempt,
    max_attempts: max,
  };
}

/**
 * Determine if a worktree should be reused for repair.
 *
 * @param {object} options
 * @param {object} options.task - Task with worktree info
 * @param {string} [options.cleanupPolicy] - Cleanup policy for the original worktree
 * @returns {{ reuse_worktree: boolean, reason: string }}
 */
export function shouldReuseWorktreeForRepair({ task = {}, cleanupPolicy } = {}) {
  const policy = cleanupPolicy || process.env.GPTWORK_WORKTREE_CLEANUP_POLICY || 'remove_on_success_retain_on_failure';

  if (task.worktree_path && policy !== 'always_remove') {
    return { reuse_worktree: true, reason: `Reusing existing worktree at ${task.worktree_path}` };
  }

  return { reuse_worktree: false, reason: 'Creating new worktree for repair task' };
}

// ---------------------------------------------------------------------------
// P0: Repair parent-child completion loop
// ---------------------------------------------------------------------------
// When a repair task completes successfully, find the parent task that was
// waiting_for_repair and trigger re-verification / integration.
//
// The function:
// 1. Checks if the completed task is a repair task (has parent_task_id).
// 2. Looks up the parent task in the store.
// 3. If the parent is still in waiting_for_repair, marks it as re-verified
//    and triggers integration queue (if applicable).
// 4. The parent task result is updated to reflect the repair cycle outcome.
//
// @param {object} options
// @param {object} options.store - State store
// @param {object} options.config - Server config
// @param {object} options.completedTask - The repair task that just completed
// @param {boolean} options.passed - Whether the repair task passed acceptance
// @param {object} [options.parentTask] - Pre-resolved parent task (optional, saves a store load)
// @returns {Promise<{ parent_updated: boolean, parent_task_id: string|null, parent_status: string|null, error?: string }>}
export async function handleRepairCompletion({ store, config, completedTask, passed, parentTask } = {}) {
  if (!completedTask) {
    return { parent_updated: false, parent_task_id: null, parent_status: null, error: "No completed task provided" };
  }

  // Only process repair tasks (those with a parent_task_id or repair_of_task_id)
  const parentTaskId = completedTask.parent_task_id || completedTask.repair_of_task_id || null;
  if (!parentTaskId) {
    // Write skipped_no_parent agent run before returning
    await writeRepairerAgentRun(store, { task_id: completedTask.id, goal_id: completedTask.goal_id, repairOutcome: { passed: false, repair_outcome: "skipped_no_parent", reason: "Not a repair task — no parent_task_id" } }, {}).catch(() => {});
    return { parent_updated: false, parent_task_id: null, parent_status: null, reason: "Not a repair task — no parent_task_id" };
  }

  try {
    const result = await store.mutate((state) => {
      state.tasks ||= [];
      state.goals ||= [];

      // Find parent task
      const parent = parentTask || state.tasks.find((t) => t.id === parentTaskId);
      if (!parent) {
        return { parent_updated: false, parent_task_id: parentTaskId, parent_status: null, error: `Parent task not found: ${parentTaskId}` };
      }

      // Only update if parent is still in waiting_for_repair or a related hold status
      const updatableStatuses = new Set(["waiting_for_repair", "waiting_for_review", "waiting_for_integration", "running"]);
      if (!updatableStatuses.has(parent.status)) {
        return { parent_updated: false, parent_task_id: parentTaskId, parent_status: parent.status, reason: `Parent task ${parentTaskId} is in status "${parent.status}", not updatable` };
      }

      if (!passed) {
        // Compute remaining repair budget.
        const parentMaxAttempts_ = parent.max_attempts || parent.maxAttempts || 2;
        // Check both top-level repair_attempt (set by repair creation code)
        // and result-level repair_attempt (set by transitionTaskForWorker).
        // Also use completedTask's repair_attempt as the upper bound.
        let _pa = Number(parent.repair_attempt || 0);
        if (!_pa && parent.result && parent.result.repair_attempt) {
          _pa = Number(parent.result.repair_attempt);
        }
        _pa = Math.max(_pa, Number(completedTask.repair_attempt || 0), Number(completedTask.attempt || 0));
        const parentAttemptSoFar_ = _pa;
        const budgetRemaining_ = parentAttemptSoFar_ < parentMaxAttempts_;
        const nextAttempt_ = parentAttemptSoFar_ + 1;

        parent.result = parent.result || {};

        if (budgetRemaining_) {
          // Budget remains: keep parent in waiting_for_repair for next attempt
          parent.repair_attempt = nextAttempt_;
          parent.attempt = nextAttempt_;
          parent.status = "waiting_for_repair";
          parent.result.kind = "repair_continued";
          parent.result.repair_outcome = "continued";
          parent.result.repair_attempts = (parent.result.repair_attempts || 0) + 1;
          parent.result.summary = `Repair task ${completedTask.id} completed without advancing closure; preparing next repair attempt (${nextAttempt_}/${parentMaxAttempts_}).`;
          // Clear stale repair path metadata so the finalizer re-evaluates.
          delete parent.result.repair_goal_id;
          delete parent.result.repair_task_id;
          delete parent.result.repair_goal;
          parent.updated_at = new Date().toISOString();
          if (!Array.isArray(parent.logs)) parent.logs = [];
          parent.logs.push({ time: new Date().toISOString(), message: `[repair-loop] Repair task ${completedTask.id} terminal; parent ${parentTaskId} stays waiting_for_repair for next attempt ${nextAttempt_}/${parentMaxAttempts_}` });
          return { parent_updated: true, parent_task_id: parentTaskId, parent_status: "waiting_for_repair", repair_outcome: "continued", next_attempt: nextAttempt_ };
        }

        // Budget exhausted - move to explicit human-review terminal state
        delete parent.result.repair_goal_id;
        delete parent.result.repair_task_id;
        delete parent.result.repair_goal;
        parent.status = "human_interrupted_for_repair_budget_exhausted";
        parent.result.kind = "repair_budget_exhausted";
        parent.result.repair_outcome = "budget_exhausted";
        parent.result.summary = `Repair task ${completedTask.id} failed; repair budget exhausted (${parentAttemptSoFar_}/${parentMaxAttempts_}). Requires human review.`;
        parent.result.completed_at = new Date().toISOString();
        parent.updated_at = new Date().toISOString();
        if (!Array.isArray(parent.logs)) parent.logs = [];
        parent.logs.push({ time: new Date().toISOString(), message: `[repair-loop] Repair task ${completedTask.id} failed; parent ${parentTaskId} -- budget exhausted (${parentAttemptSoFar_}/${parentMaxAttempts_}). Requires human review.` });

        // Update goal status too
        if (completedTask.goal_id) {
          const goal = state.goals.find((g) => g.id === completedTask.goal_id);
          if (goal) {
            goal.status = "failed";
            goal.updated_at = new Date().toISOString();
          }
        }
        return { parent_updated: true, parent_task_id: parentTaskId, parent_status: "human_interrupted_for_repair_budget_exhausted", repair_outcome: "budget_exhausted" };

      }

      // Repair task passed — re-verify parent
      parent.result = parent.result || {};
      parent.result.repair_outcome = "repaired";
      // Clear stale repair path so finalizer re-evaluates without old metadata
      delete parent.result.repair_goal_id;
      delete parent.result.repair_task_id;
      delete parent.result.repair_goal;
      parent.result.repaired_by_task_id = completedTask.id;
      parent.result.repair_attempts = (parent.result.repair_attempts || 0) + 1;
      parent.result.repair_status = "completed";
      parent.result.last_repaired_at = new Date().toISOString();
      // P0-AFC: Mark the parent task as resolved by this successor so the
      // review backlog reconciler knows the original task is no longer blocked.
      parent.resolved_by_task_id = completedTask.id;
      parent.result.resolved_by_task_id = completedTask.id;

      // If parent has a worktree, trigger re-integration
      // Otherwise, mark as completed directly
      const hasWorktree = Boolean(
        parent.worktree?.path
        || parent.result?.repo_resolution?.task_worktree_path
        || parent.result?.worktree_lifecycle?.worktree_path
        || completedTask.result?.repo_resolution?.task_worktree_path
        || completedTask.result?.worktree_lifecycle?.worktree_path
      );

      if (hasWorktree) {
        // Mark parent for re-integration — the worker loop will pick it up
        // from waiting_for_integration status and retry the integration queue
        parent.status = "waiting_for_integration";
        parent.logs ||= [];
        parent.logs.push({ time: new Date().toISOString(), message: `[repair-loop] Repair task ${completedTask.id} passed; parent ${parentTaskId} re-queued for integration` });
        return { parent_updated: true, parent_task_id: parentTaskId, parent_status: "waiting_for_integration", repair_outcome: "repaired" };
      }

      // No worktree — mark parent completed directly
      parent.status = "completed";
      parent.result.summary = parent.result.summary || `Repaired by ${completedTask.id}`;
      parent.logs ||= [];
      parent.logs.push({ time: new Date().toISOString(), message: `[repair-loop] Repair task ${completedTask.id} passed; parent ${parentTaskId} completed` });

      // --- P0: Update parent task's goal status ---
      // The repair task has its own goal; we must also update the parent's
      // original goal so the system shows the correct overall status.
      if (parent.goal_id) {
        const parentGoal = state.goals.find((g) => g.id === parent.goal_id);
        if (parentGoal) {
          parentGoal.status = "completed";
          parentGoal.updated_at = new Date().toISOString();
        }
      }

      // --- P0: Cascade to root task if different from parent ---
      // When parent_task_id !== root_task_id, the root task must also
      // be auto-closed to prevent an incomplete task chain.
      const rootTaskId = parent.root_task_id || completedTask.root_task_id;
      if (rootTaskId && rootTaskId !== parent.id && rootTaskId !== parentTaskId) {
        const rootTask = state.tasks.find((t) => t.id === rootTaskId);
        if (rootTask && !["completed", "failed", "cancelled"].includes(rootTask.status)) {
          rootTask.status = "completed";
          rootTask.result = rootTask.result || {};
          rootTask.result.repair_outcome = "completed_via_child";
          rootTask.result.summary = `Root task completed via repair cascade from ${parentTaskId}`;
          rootTask.updated_at = new Date().toISOString();
          rootTask.logs ||= [];
          rootTask.logs.push({ time: new Date().toISOString(), message: `[repair-loop] Root task auto-closed via repair cascade from ${parentTaskId}` });
          // Update root task's goal
          if (rootTask.goal_id) {
            const rootGoal = state.goals.find((g) => g.id === rootTask.goal_id);
            if (rootGoal) {
              rootGoal.status = "completed";
              rootGoal.updated_at = new Date().toISOString();
            }
          }
        }
      }

      return { parent_updated: true, parent_task_id: parentTaskId, parent_status: "completed", repair_outcome: "repaired" };
    });


    // Agent run writeback: repairer (non-blocking)
    const _repairOutcome = result || {};
    await writeRepairerAgentRun(store, {
      task_id: completedTask.id,
      goal_id: completedTask.goal_id,
      repairOutcome: {
        passed: _repairOutcome.repair_outcome === "repaired",
        repair_outcome: _repairOutcome.repair_outcome || "unknown",
        reason: _repairOutcome.error || _repairOutcome.reason || null,
      },
    }, {}).catch(() => {});

    return result;
  } catch (error) {
    return { parent_updated: false, parent_task_id: parentTaskId, parent_status: null, error: error.message || String(error) };
  }
}
