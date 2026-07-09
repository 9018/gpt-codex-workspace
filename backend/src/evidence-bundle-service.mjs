import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readTestsFromResultJson(path) {
  if (!(await exists(path))) return [];
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(json.tests) ? json.tests : [];
  } catch {
    return [];
  }
}

export async function collectEvidenceBundle({ goalId, workspace }) {
  const cwd = workspace.worktree_path;
  const goalDir = join(cwd, '.gptwork', 'goals', goalId);
  const candidateHead = await git(cwd, ['rev-parse', 'HEAD']);
  const mergeBase = await git(cwd, ['merge-base', workspace.merge_target, 'HEAD']);
  const status = await git(cwd, ['status', '--short']);
  const changedFiles = lines(await git(cwd, ['diff', '--name-only', `${workspace.merge_target}...HEAD`]))
    .filter((file) => !file.startsWith('.gptwork/goals/'));
  const commitLines = lines(await git(cwd, ['log', '--pretty=%H%x09%s', `${workspace.merge_target}..HEAD`]));
  const commits = commitLines.map((line) => {
    const [sha, ...rest] = line.split('\t');
    return { sha, subject: rest.join('\t') };
  });
  const resultMdPath = join(goalDir, 'result.md');
  const resultJsonPath = join(goalDir, 'result.json');
  const evidence = {
    goal_id: goalId,
    base_branch: workspace.base_branch,
    base_sha: workspace.base_sha,
    candidate_branch: workspace.candidate_branch,
    candidate_head: candidateHead,
    worktree_path: cwd,
    worktree_clean: status.length === 0,
    changed_files: changedFiles,
    commits,
    result_md_present: await exists(resultMdPath),
    result_json_present: await exists(resultJsonPath),
    tests: await readTestsFromResultJson(resultJsonPath),
    merge_base: mergeBase,
    diff_stat: await git(cwd, ['diff', '--stat', `${workspace.merge_target}...HEAD`]).catch(() => ''),
    generated_at: new Date().toISOString()
  };

  await writeJson(join(goalDir, 'evidence.bundle.json'), evidence);
  return evidence;
}
