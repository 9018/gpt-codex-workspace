import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export function buildCodexAcceptanceGoalPrompt({ goalId }) {
  return `/goal Read .gptwork/goals/${goalId}/codex.acceptance.entry.md first. Review the candidate branch evidence against acceptance.contract.json. Write acceptance.result.json with verdict, findings, reviewed_candidate_head, and merge_recommendation.\n`;
}

export async function runCodexTuiAccept({ invocation, goal, workspace, config, deps = {} }) {
  if (String(process.env.GPTWORK_CODEX_TUI_ENABLED || config.codexTuiEnabled || '').toLowerCase() !== 'true') {
    return {
      status: 'blocked',
      kind: 'codex_tui_disabled',
      reason: 'TUI was explicitly disabled by GPTWORK_CODEX_TUI_ENABLED=false'
    };
  }

  const command = config.codexCommand || process.env.GPTWORK_CODEX_COMMAND || 'codex';
  const args = config.codexTuiArgs || [];
  const goalDir = join(workspace.worktree_path, '.gptwork', 'goals', goal.id);
  await writeText(invocation.entry_file, buildCodexAcceptanceEntry({ goal, workspace }));

  const prompt = buildCodexAcceptanceGoalPrompt({ goalId: goal.id });
  const sessionLog = join(goalDir, 'codex.acceptance.tui.session.log');
  const spawnImpl = deps.spawn || spawn;
  const child = spawnImpl(command, args, {
    cwd: invocation.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdout?.on?.('data', async (chunk) => writeText(sessionLog, String(chunk)).catch(() => {}));
  child.stderr?.on?.('data', async (chunk) => writeText(sessionLog, String(chunk)).catch(() => {}));
  child.stdin?.write?.(prompt);

  return {
    kind: 'codex_tui_accept_started',
    status: 'running',
    provider: 'codex_tui_goal',
    pid: child.pid || null,
    cwd: invocation.cwd,
    session_log: sessionLog,
    prompt
  };
}

function buildCodexAcceptanceEntry({ goal, workspace }) {
  return `# Codex Acceptance Entry

Goal ID: ${goal.id}
Candidate branch: ${workspace.candidate_branch}
Worktree: ${workspace.worktree_path}
Merge target: ${workspace.merge_target}

## Inputs

Read these files:

- .gptwork/goals/${goal.id}/acceptance.contract.json
- .gptwork/goals/${goal.id}/evidence.bundle.json
- .gptwork/goals/${goal.id}/result.md
- .gptwork/goals/${goal.id}/result.json

## Output

Write .gptwork/goals/${goal.id}/acceptance.result.json with this shape:

{
  "goal_id": "${goal.id}",
  "stage": "accept",
  "provider": "codex_tui_goal",
  "verdict": "passed|failed|partial|blocked",
  "confidence": "high|medium|low",
  "blocking_findings": [],
  "non_blocking_findings": [],
  "required_changes": [],
  "merge_recommendation": "merge|do_not_merge|repair_first|ask_user",
  "reviewed_candidate_head": "<current HEAD>",
  "created_at": "<ISO timestamp>"
}
`;
}
