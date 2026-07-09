import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export function buildClaudeTuiGoalPrompt({ goalId }) {
  return `/goal Read .gptwork/goals/${goalId}/claude.entry.md first. Execute this goal in the current goal worktree only. Continue until result.md and result.json exist, verification evidence is recorded, the candidate worktree is clean, and commit evidence is present.\n`;
}

export async function runClaudeTuiGoal({ invocation, goal, workspace, config, deps = {} }) {
  if (String(process.env.GPTWORK_CLAUDE_TUI_ENABLED || config.claudeTuiEnabled || '').toLowerCase() !== 'true') {
    return {
      status: 'blocked',
      kind: 'claude_tui_disabled',
      reason: 'GPTWORK_CLAUDE_TUI_ENABLED is not true'
    };
  }

  const command = config.claudeCommand || process.env.GPTWORK_CLAUDE_COMMAND || 'claude';
  const args = config.claudeTuiArgs || [];
  const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', goal.id);
  const prompt = buildClaudeTuiGoalPrompt({ goalId: goal.id });
  await writeText(invocation.entry_file, buildClaudeEntry({ goal, workspace }));

  const sessionLog = join(goalDir, 'claude.tui.session.log');
  const spawnImpl = deps.spawn || spawn;
  const child = spawnImpl(command, args, {
    cwd: invocation.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdout?.on?.('data', async (chunk) => {
    await writeText(sessionLog, String(chunk)).catch(() => {});
  });
  child.stderr?.on?.('data', async (chunk) => {
    await writeText(sessionLog, String(chunk)).catch(() => {});
  });

  child.stdin?.write?.(prompt);

  return {
    kind: 'claude_tui_goal_started',
    status: 'running',
    provider: 'claude_tui_goal',
    pid: child.pid || null,
    cwd: invocation.cwd,
    session_log: sessionLog,
    prompt
  };
}

function buildClaudeEntry({ goal, workspace }) {
  return `# Claude Execute Entry

Goal ID: ${goal.id}
Candidate branch: ${workspace.candidate_branch}
Worktree: ${workspace.worktree_path}
Merge target: ${workspace.merge_target}

## Contract

Execute this goal only inside the current worktree. Do not edit the merge target branch directly.

When complete, produce durable evidence:

1. .gptwork/goals/${goal.id}/result.md
2. .gptwork/goals/${goal.id}/result.json
3. verification/test commands and outcomes
4. commit evidence or explicit no-change reason
5. clean git status

GPTWork will not use TUI screen text as completion evidence.
`;
}
