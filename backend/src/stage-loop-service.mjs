import { defaultProviderForStage, buildStageInvocation, PROVIDERS } from './stage-invocation-contract.mjs';
import { runClaudeTuiGoal } from './providers/claude-tui-goal-provider.mjs';
import { runCodexTuiAccept } from './providers/codex-tui-accept-provider.mjs';
import { runClaudeExecAdvance } from './providers/claude-exec-advance-provider.mjs';

export async function runStage({ goal, task = null, stage, workspace, config, deps = {} }) {
  const provider = defaultProviderForStage(stage, config);
  const invocation = buildStageInvocation({
    goalId: goal.id,
    taskId: task?.id || null,
    stage,
    provider,
    worktreePath: workspace.worktree_path
  });

  const started = { ...invocation, status: 'running', started_at: new Date().toISOString() };

  let result;
  if (provider === PROVIDERS.CLAUDE_TUI_GOAL && stage === 'execute') {
    result = await runClaudeTuiGoal({ invocation: started, goal, workspace, config, deps });
  } else if (provider === PROVIDERS.CODEX_TUI_GOAL && stage === 'accept') {
    result = await runCodexTuiAccept({ invocation: started, goal, workspace, config, deps });
  } else if (provider === PROVIDERS.CLAUDE_EXEC_GOAL && stage === 'advance') {
    result = await runClaudeExecAdvance({ invocation: started, goal, workspace, config, deps });
  } else {
    throw new Error(`provider ${provider} does not support stage ${stage} in MVP`);
  }

  return {
    ...started,
    status: result.status || 'completed',
    completed_at: result.completed_at || new Date().toISOString(),
    provider_result: result
  };
}
