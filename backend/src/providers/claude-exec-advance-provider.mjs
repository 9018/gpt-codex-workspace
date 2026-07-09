import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export function buildClaudeAdvancePrompt({ goalId }) {
  return `/goal Read .gptwork/goals/${goalId}/advance.entry.md. Output only valid JSON matching advance.result.json. Decide one of: create_next_goal, request_repair, ask_user, stop.`;
}

export async function runClaudeExecAdvance({ invocation, goal, workspace, config, deps = {} }) {
  if (String(process.env.GPTWORK_CLAUDE_EXEC_ADVANCE_ENABLED || config.claudeExecAdvanceEnabled || '').toLowerCase() !== 'true') {
    return {
      status: 'blocked',
      kind: 'claude_exec_advance_disabled',
      reason: 'GPTWORK_CLAUDE_EXEC_ADVANCE_ENABLED is not true'
    };
  }

  const command = config.claudeCommand || process.env.GPTWORK_CLAUDE_COMMAND || 'claude';
  const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', goal.id);
  await writeText(invocation.entry_file, buildAdvanceEntry({ goal, workspace }));

  const prompt = buildClaudeAdvancePrompt({ goalId: goal.id });
  const execImpl = deps.execFileAsync || execFileAsync;
  const { stdout, stderr } = await execImpl(command, ['-p', prompt], {
    cwd: invocation.cwd,
    encoding: 'utf8',
    timeout: config.advanceTimeoutMs || 300_000,
    maxBuffer: 1024 * 1024
  });

  const outPath = join(goalDir, 'advance.result.json');
  await writeText(join(goalDir, 'advance.stdout.log'), stdout || '');
  await writeText(join(goalDir, 'advance.stderr.log'), stderr || '');

  const trimmed = String(stdout || '').trim();
  if (trimmed.startsWith('{')) await writeText(outPath, `${trimmed}\n`);

  return {
    kind: 'claude_exec_advance_completed',
    status: 'completed',
    provider: 'claude_exec_goal',
    stdout_log: join(goalDir, 'advance.stdout.log'),
    stderr_log: join(goalDir, 'advance.stderr.log'),
    output_path: outPath
  };
}

function buildAdvanceEntry({ goal, workspace }) {
  return `# Claude Advance Entry

Goal ID: ${goal.id}
Candidate branch: ${workspace.candidate_branch}
Merge target: ${workspace.merge_target}

Read:

- .gptwork/goals/${goal.id}/merge.result.json if present
- .gptwork/goals/${goal.id}/merge.decision.json
- .gptwork/goals/${goal.id}/acceptance.result.json
- .gptwork/goals/${goal.id}/evidence.bundle.json

Decide one:

1. create_next_goal
2. request_repair
3. ask_user
4. stop

Output only JSON matching advance-result.schema.json.
`;
}
