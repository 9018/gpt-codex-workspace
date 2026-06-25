/**
 * repair-loop.mjs — Automatic repair loop for failed acceptance tasks.
 *
 * Creates repair tasks from acceptance findings, tracks repair attempts,
 * and manages the repair lifecycle.
 */

import { randomUUID } from 'node:crypto';

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
  const attempt = (task.repair_attempt || 0) + 1;
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
