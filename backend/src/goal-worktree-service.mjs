import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function assertGoalId(goalId) {
  const id = String(goalId || '').trim();
  if (!/^goal_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid goal_id: ${goalId}`);
  return id;
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

export function goalWorktreePath({ config, goalId }) {
  const root = config.goalWorktreeRoot || join(config.defaultWorkspaceRoot, '.gptwork', 'worktrees');
  return join(root, goalId);
}

export function goalBranchName({ config, goalId }) {
  const prefix = config.goalBranchPrefix || 'gptwork/goal';
  return `${prefix}/${goalId}`;
}

async function branchExists(repoPath, branch) {
  try {
    await git(repoPath, ['rev-parse', '--verify', branch]);
    return true;
  } catch {
    return false;
  }
}

async function ensureBranchAndWorktree({ repoPath, branch, worktreePath, baseBranch }) {
  const hasWorktree = await pathExists(worktreePath);
  if (hasWorktree) {
    const currentBranch = await git(worktreePath, ['branch', '--show-current']);
    if (currentBranch !== branch) {
      throw new Error(`worktree exists but is on ${currentBranch}, expected ${branch}: ${worktreePath}`);
    }
    return;
  }

  const exists = await branchExists(repoPath, branch);
  await mkdir(dirname(worktreePath), { recursive: true });
  if (exists) {
    await git(repoPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
  }
}

export async function ensureGoalWorkspace({ goal, config }) {
  const goalId = assertGoalId(goal.id);
  const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
  const baseBranch = goal.base_branch || config.mergeTargetBranch || config.defaultBranch || 'main';
  const branch = goalBranchName({ config, goalId });
  const worktreePath = goalWorktreePath({ config, goalId });
  const baseSha = await git(repoPath, ['rev-parse', baseBranch]);

  await ensureBranchAndWorktree({ repoPath, branch, worktreePath, baseBranch });

  const workspace = {
    goal_id: goalId,
    base_branch: baseBranch,
    base_sha: baseSha,
    candidate_branch: branch,
    worktree_path: worktreePath,
    merge_target: baseBranch,
    workspace_status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const goalDir = join(worktreePath, '.gptwork', 'goals', goalId);
  await writeJson(join(goalDir, 'workspace.json'), workspace);
  await writeText(join(goalDir, 'resume.md'), buildManualResumeMarkdown({ workspace }));
  return workspace;
}

export async function rescanGoalWorkspace({ goalId, config }) {
  const id = assertGoalId(goalId);
  const worktreePath = goalWorktreePath({ config, goalId: id });
  const branch = await git(worktreePath, ['branch', '--show-current']);
  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  const status = await git(worktreePath, ['status', '--short']);
  return {
    goal_id: id,
    worktree_path: worktreePath,
    candidate_branch: branch,
    candidate_head: head,
    worktree_clean: status.length === 0,
    dirty_status: status ? status.split(/\r?\n/) : [],
    rescanned_at: new Date().toISOString()
  };
}

function buildManualResumeMarkdown({ workspace }) {
  return `# Manual Resume

Goal ID: ${workspace.goal_id}
Candidate branch: ${workspace.candidate_branch}
Worktree: ${workspace.worktree_path}
Merge target: ${workspace.merge_target}

## Claude execution

\`\`\`bash
cd ${workspace.worktree_path}
claude
/resume
\`\`\`

## Codex review or repair

\`\`\`bash
cd ${workspace.worktree_path}
codex
/resume
\`\`\`

## Required completion evidence

Before expecting GPTWork to merge this branch, ensure:

- .gptwork/goals/${workspace.goal_id}/result.md exists
- .gptwork/goals/${workspace.goal_id}/result.json exists
- tests or verification are recorded in result.json or evidence bundle
- git status is clean
- candidate branch contains commit evidence

GPTWork does not collect your TUI conversation. It only rescans this branch and these files.
`;
}
