/**
 * acceptance-repair-adapter.mjs — Acceptance/repair integration for TUI sessions.
 *
 * Bridges the TUI session lifecycle with the acceptance and repair
 * pipeline.  Currently a thin re-export shim; will be expanded in later Waves.
 *
 * @module acceptance-repair-adapter
 */

// Re-export key utilities used beyond the session manager boundary.
export { isContractValidTerminalResult } from "./session-terminalizer.mjs";
export { releaseLockForTask } from "../repo-lock.mjs";
