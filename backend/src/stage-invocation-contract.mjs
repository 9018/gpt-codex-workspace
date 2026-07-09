import { join } from 'node:path';

export const STAGES = Object.freeze({
  EXECUTE: 'execute',
  ACCEPT: 'accept',
  REPAIR: 'repair',
  ADVANCE: 'advance'
});

export const PROVIDERS = Object.freeze({
  CLAUDE_TUI_GOAL: 'claude_tui_goal',
  CODEX_TUI_GOAL: 'codex_tui_goal',
  CLAUDE_EXEC_GOAL: 'claude_exec_goal',
  CODEX_EXEC: 'codex_exec'
});

export function defaultProviderForStage(stage, config = {}) {
  if (stage === STAGES.EXECUTE) return config.executeProvider || process.env.GPTWORK_EXECUTE_PROVIDER || PROVIDERS.CLAUDE_TUI_GOAL;
  if (stage === STAGES.ACCEPT) return config.acceptProvider || process.env.GPTWORK_ACCEPT_PROVIDER || PROVIDERS.CODEX_TUI_GOAL;
  if (stage === STAGES.ADVANCE) return config.advanceProvider || process.env.GPTWORK_ADVANCE_PROVIDER || PROVIDERS.CLAUDE_EXEC_GOAL;
  if (stage === STAGES.REPAIR) return config.repairProvider || process.env.GPTWORK_REPAIR_PROVIDER || PROVIDERS.CLAUDE_TUI_GOAL;
  throw new Error(`unsupported stage: ${stage}`);
}

export function buildStageInvocation({ goalId, taskId = null, stage, provider, worktreePath }) {
  const goalDir = join(worktreePath, '.gptwork', 'goals', goalId);
  const entryFile = stage === STAGES.EXECUTE
    ? join(goalDir, 'claude.entry.md')
    : stage === STAGES.ACCEPT
      ? join(goalDir, 'codex.acceptance.entry.md')
      : stage === STAGES.ADVANCE
        ? join(goalDir, 'advance.entry.md')
        : join(goalDir, 'repair.entry.md');

  const expectedOutputs = stage === STAGES.EXECUTE
    ? [join(goalDir, 'result.md'), join(goalDir, 'result.json')]
    : stage === STAGES.ACCEPT
      ? [join(goalDir, 'acceptance.result.json')]
      : stage === STAGES.ADVANCE
        ? [join(goalDir, 'advance.result.json')]
        : [join(goalDir, 'result.md'), join(goalDir, 'result.json')];

  return {
    invocation_id: `inv_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    goal_id: goalId,
    task_id: taskId,
    stage,
    provider,
    cwd: worktreePath,
    entry_file: entryFile,
    expected_outputs: expectedOutputs,
    status: 'pending',
    started_at: null,
    completed_at: null
  };
}
