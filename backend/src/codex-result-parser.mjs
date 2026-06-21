/**
 * codex-result-parser.mjs — compatibility facade for Codex result parsing.
 */

export { parseResultJson } from "./codex-result-json-parser.mjs";
export { parseCodexResult } from "./codex-result-stdout-parser.mjs";
export { parseCodexResultWithFallback } from "./codex-result-fallback-parser.mjs";
export { buildTaskResult } from "./codex-task-result-builder.mjs";
export { normalizeRoleName, detectRuntimeCodeChanges, validateAutonomyResult } from "./codex-autonomy-validator.mjs";
