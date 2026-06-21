const DEFAULT_SEARCH_EXCLUDE_DIRS = [".git", "node_modules", "dist", "build", "coverage", ".next", "vendor"];
export const DEFAULT_SEARCH_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_SEARCH_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export function normalizeSearchExcludeDirs(excludeDirs) {
  const values = Array.isArray(excludeDirs) ? excludeDirs : [];
  return new Set([...DEFAULT_SEARCH_EXCLUDE_DIRS, ...values]
    .map((item) => String(item || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean));
}

export function looksBinary(bytes) {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}
