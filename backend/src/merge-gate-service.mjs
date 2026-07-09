import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function hasMergeConflict({ repoPath, target, branch }) {
  try {
    await git(repoPath, ['merge-tree', '--write-tree', target, branch]);
    return false;
  } catch {
    return true;
  }
}

export async function previewMergeGate({ goalId, workspace, config }) {
  const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
  const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', goalId);

  let evidence, acceptance;
  try {
    evidence = await readJson(join(goalDir, 'evidence.bundle.json'));
  } catch {
    evidence = null;
  }
  try {
    acceptance = await readJson(join(goalDir, 'acceptance.result.json'));
  } catch {
    acceptance = null;
  }

  if (!evidence || !acceptance) {
    const result = {
      goal_id: goalId,
      decision: 'reject',
      reason: !evidence ? 'evidence bundle not found' : 'acceptance result not found',
      candidate_branch: workspace.candidate_branch,
      candidate_head: evidence?.candidate_head || '',
      merge_target: workspace.merge_target,
      checks: {
        acceptance_passed: false,
        worktree_clean: evidence?.worktree_clean === true,
        result_contract_valid: evidence?.result_md_present === true && evidence?.result_json_present === true,
        reviewed_head_current: false,
        merge_conflict: false
      },
      created_at: new Date().toISOString()
    };
    await writeJson(join(goalDir, 'merge.decision.json'), result);
    return result;
  }
  const mergeConflict = await hasMergeConflict({ repoPath, target: workspace.merge_target, branch: workspace.candidate_branch });

  const checks = {
    acceptance_passed: acceptance.verdict === 'passed' && acceptance.merge_recommendation === 'merge',
    worktree_clean: evidence.worktree_clean === true,
    result_contract_valid: evidence.result_md_present === true && evidence.result_json_present === true,
    reviewed_head_current: acceptance.reviewed_candidate_head === evidence.candidate_head,
    merge_conflict: mergeConflict
  };

  const decision = checks.acceptance_passed && checks.worktree_clean && checks.result_contract_valid && checks.reviewed_head_current && !checks.merge_conflict
    ? 'merge'
    : checks.merge_conflict
      ? 'conflict'
      : acceptance.verdict === 'partial' || acceptance.merge_recommendation === 'repair_first'
        ? 'request_repair'
        : 'reject';

  const result = {
    goal_id: goalId,
    decision,
    reason: buildReason(checks, acceptance),
    candidate_branch: workspace.candidate_branch,
    candidate_head: evidence.candidate_head,
    merge_target: workspace.merge_target,
    checks,
    created_at: new Date().toISOString()
  };

  await writeJson(join(goalDir, 'merge.decision.json'), result);
  return result;
}

export async function applyMergeGate({ goalId, workspace, config }) {
  const decision = await previewMergeGate({ goalId, workspace, config });
  if (decision.decision !== 'merge') return { merged: false, decision };

  const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
  await git(repoPath, ['checkout', workspace.merge_target]);
  await git(repoPath, ['merge', '--no-ff', workspace.candidate_branch, '-m', `merge: ${goalId}`]);
  const mergeCommit = await git(repoPath, ['rev-parse', 'HEAD']);

  const result = {
    merged: true,
    merge_commit: mergeCommit,
    candidate_branch: workspace.candidate_branch,
    candidate_head: decision.candidate_head,
    target_branch: workspace.merge_target,
    merged_at: new Date().toISOString()
  };

  await writeJson(join(workspace.worktree_path, '.gptwork', 'goals', goalId, 'merge.result.json'), result);
  return result;
}

function buildReason(checks, acceptance) {
  if (!checks.acceptance_passed) return `acceptance is not passed: verdict=${acceptance.verdict}, recommendation=${acceptance.merge_recommendation}`;
  if (!checks.worktree_clean) return 'candidate worktree is dirty';
  if (!checks.result_contract_valid) return 'result.md or result.json missing';
  if (!checks.reviewed_head_current) return 'acceptance reviewed an older candidate head';
  if (checks.merge_conflict) return 'candidate branch conflicts with merge target';
  return 'all merge gate checks passed';
}
