/**
 * claude-tui-session-manager.mjs — Claude Code TUI session management.
 *
 * Wraps agent-tui-session-core.mjs with Claude-specific PTY adapter
 * (command: claude) and Claude-specific goal prompt builders.
 *
 * Shares the same session store and active session registry as the
 * codex TUI session manager, allowing both providers to coexist.
 */

import { createAgentTuiPtyAdapter } from "./codex-tui-pty-adapter.mjs";
import { buildClaudeTuiBootstrapMessages } from "./claude-tui-goal-prompt.mjs";
import { createAgentTuiSessionManager } from "./agent-tui-session-core.mjs";
import { getClaudeTuiConfig } from "./codex-execution-provider.mjs";

const _claudeConfig = getClaudeTuiConfig();

const _manager = createAgentTuiSessionManager({
  providerName: "claude",
  createPtyAdapter: () => createAgentTuiPtyAdapter({ command: _claudeConfig.command }),
  buildBootstrapMessages: ({ goalId, taskTitle }) =>
    buildClaudeTuiBootstrapMessages({ goalId, taskTitle, entryFile: "claude.entry.md" }),
});

export const startClaudeTuiGoalSession = _manager.startGoalSession;
export const resumeClaudeTuiSession = _manager.resumeSession;
export const readClaudeTuiSession = _manager.readSession;
export const sendClaudeTuiSessionInput = _manager.sendSessionInput;
export const stopClaudeTuiSession = _manager.stopSession;
export const getClaudeTuiSessionStatus = _manager.getSessionStatus;
export const resetClaudeTuiSessionManagerForTests = _manager.resetForTests;
