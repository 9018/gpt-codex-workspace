/**
 * codex-tui-session-manager.mjs — Backward-compatible facade.
 *
 * This file is kept for backward compatibility with existing importers.
 * All logic has been moved to backend/src/codex-tui/ sub-modules.
 *
 * New code should import directly from the codex-tui module:
 *   import { startCodexTuiGoalSession } from "./codex-tui/index.mjs";
 *
 * @module codex-tui-session-manager
 */

export { startCodexTuiGoalSession } from "./codex-tui/session-service.mjs";
export { readCodexTuiSession, stopCodexTuiSession, getCodexTuiSessionStatus } from "./codex-tui/session-service.mjs";
export { sendCodexTuiSessionInput, sendCodexTuiTaskDelta } from "./codex-tui/session-input-service.mjs";
export { resetCodexTuiSessionRegistryForTests as resetCodexTuiSessionManagerForTests } from "./codex-tui/active-session-registry.mjs";
export { findStoreForSession as storeForSession } from "./codex-tui/session-bootstrap.mjs";
export { cleanupIsolatedWorktreeProcesses, isProcessAlive } from "./codex-tui/session-process-cleanup.mjs";
export { normalizeRecoveredSessionRecord } from "./codex-tui/session-recovery.mjs";
export {
  terminalizeCodexTuiSession,
  normalizeTerminalEvent,
  isContractValidTerminalResult,
  readTerminalResult,
  readTerminalResultWithRetry,
  writeJsonAtomic,
  failClosedResult,
} from "./codex-tui/session-terminalizer.mjs";
