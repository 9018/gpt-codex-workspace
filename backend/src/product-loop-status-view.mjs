import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function buildGoalLoopStatus({ goal, workspace }) {
  const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', goal.id);
  const evidence = await readJsonOrNull(join(goalDir, 'evidence.bundle.json'));
  const acceptance = await readJsonOrNull(join(goalDir, 'acceptance.result.json'));
  const mergeDecision = await readJsonOrNull(join(goalDir, 'merge.decision.json'));
  const mergeResult = await readJsonOrNull(join(goalDir, 'merge.result.json'));
  const advance = await readJsonOrNull(join(goalDir, 'advance.result.json'));

  let state = 'workspace_ready';
  if (evidence?.result_md_present && evidence?.result_json_present) state = 'execute_completed';
  if (acceptance?.verdict) state = 'accept_completed';
  if (mergeDecision?.decision) state = mergeDecision.decision === 'merge' ? 'merge_gate_ready' : 'merge_blocked';
  if (mergeResult?.merged) state = 'merged';
  if (advance?.decision) state = 'advance_completed';

  return {
    goal_id: goal.id,
    title: goal.title || goal.id,
    state,
    base_branch: workspace.base_branch,
    candidate_branch: workspace.candidate_branch,
    worktree_path: workspace.worktree_path,
    execute_provider: 'claude_tui_goal',
    accept_provider: 'codex_tui_goal',
    advance_provider: 'claude_exec_goal',
    candidate_head: evidence?.candidate_head || null,
    acceptance_verdict: acceptance?.verdict || null,
    merge_decision: mergeDecision?.decision || null,
    next_action: nextAction({ state, mergeDecision, acceptance })
  };
}

function nextAction({ state, mergeDecision, acceptance }) {
  if (state === 'workspace_ready') return 'goal_start_execute';
  if (state === 'execute_completed') return 'goal_start_acceptance';
  if (state === 'accept_completed') return 'goal_merge_preview';
  if (state === 'merge_gate_ready') return 'goal_merge_apply';
  if (state === 'merged') return 'goal_advance';
  if (state === 'merge_blocked' && acceptance?.merge_recommendation === 'repair_first') return 'goal_start_repair';
  if (state === 'merge_blocked') return mergeDecision?.decision || 'inspect_merge_blocker';
  return 'inspect_goal_status';
}
