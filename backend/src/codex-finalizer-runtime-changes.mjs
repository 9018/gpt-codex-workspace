import { RUNTIME_SRC_PATTERNS } from "./codex-finalizer-constants.mjs";

export function detectRuntimeCodeChanges(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { hasRuntimeChanges: false, matchedFiles: [] };
  }
  const matchedFiles = changedFiles.filter(f =>
    RUNTIME_SRC_PATTERNS.some(pattern => pattern.test(f))
  );
  return {
    hasRuntimeChanges: matchedFiles.length > 0,
    matchedFiles,
  };
}

/**
 * Convenience wrapper: given a full result object, check whether its
 * changed_files array triggers runtime code change detection.
 *
 * This is the "warning pass-through" entry point — it lets callers
 * check a result for restart requirements without extracting
 * changed_files manually.
 *
 * @param {object} result - A parsed result object with changed_files.
 * @returns {{ hasRuntimeChanges: boolean, matchedFiles: string[] }}
 */
export function checkResultForRuntimeChanges(result) {
  if (!result || !Array.isArray(result.changed_files)) {
    return { hasRuntimeChanges: false, matchedFiles: [] };
  }
  return detectRuntimeCodeChanges(result.changed_files);
}
