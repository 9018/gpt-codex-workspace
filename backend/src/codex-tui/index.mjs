/**
 * codex-tui/index.mjs — Facade for the codex-tui module.
 *
 * Re-exports all public APIs from the sub-modules.
 * External consumers should import from this index or from the original
 * codex-tui-session-manager.mjs facade for backward compatibility.
 *
 * @module codex-tui
 */

export { startCodexTuiGoalSession, readCodexTuiSession, stopCodexTuiSession, getCodexTuiSessionStatus } from "./session-service.mjs";
export { sendCodexTuiSessionInput, sendCodexTuiTaskDelta } from "./session-input-service.mjs";
export { startCodexTuiGoalSessionImpl, sessionIdFor, findStoreForSession } from "./session-bootstrap.mjs";
export { normalizeRecoveredSessionRecord, waitForTuiOutput } from "./session-recovery.mjs";
export {
  terminalizeCodexTuiSession,
  normalizeTerminalEvent,
  isContractValidTerminalResult,
  readTerminalResult,
  readTerminalResultWithRetry,
  writeJsonAtomic,
  failClosedResult,
  recoverTerminalResultFromEvidence,
  TERMINAL_RESULT_STATUSES,
} from "./session-terminalizer.mjs";
export { cleanupIsolatedWorktreeProcesses, isProcessAlive, uniqueStrings, candidateWorkspaceRoots } from "./session-process-cleanup.mjs";
export { activeSessions, sessionStores, pendingSessionStarts, pendingTerminalizations, activeManagerForSession, resetCodexTuiSessionRegistryForTests } from "./active-session-registry.mjs";
export { snapshotNativeSessions, resolveNativeSessionBinding, createCodexSessionManifestStore } from "./native-session-binding.mjs";
