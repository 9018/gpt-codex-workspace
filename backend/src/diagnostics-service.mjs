/**
 * diagnostics-service.mjs — compatibility facade for runtime diagnostics helpers.
 */

export { CACHE_DEFAULTS, withCache, invalidateCache, getCacheStats } from "./diagnostics-cache.mjs";
export { resolveRepoDir, determineBarkConfigSource, collectRuntimeGitInfo, collectRuntimeGitInfoCached } from "./diagnostics-runtime.mjs";
export { collectRestartMarkerStatus, reconcilePendingRestartMarkers } from "./diagnostics-restart-markers.mjs";
export { queryContextStatus, collectContextIndexStatus } from "./diagnostics-context-status.mjs";
export { classifyRunFailure, QUOTA_PATTERNS, PROMPT_LENGTH_THRESHOLD } from "./codex-run-diagnostics.mjs";
