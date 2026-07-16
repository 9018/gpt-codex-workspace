import { parseNativeCodexSessionId } from "./native-session-id-parser.mjs";

export function resolveNativeSessionBinding({ output = "", before = [], after = [], cwd = null, pid = null } = {}) {
  const parsed = parseNativeCodexSessionId(output);
  if (parsed) return { nativeSessionId: parsed, source: "process_output", reason: null };

  const previous = new Set(before.map((item) => item.path));
  let candidates = after.filter((item) => !previous.has(item.path) && item.id);
  if (cwd) {
    const cwdMatches = candidates.filter((item) => item.cwd === cwd);
    if (cwdMatches.length) candidates = cwdMatches;
  }
  if (pid) {
    const pidMatches = candidates.filter((item) => item.pid === pid);
    if (pidMatches.length) candidates = pidMatches;
  }
  if (candidates.length === 1) {
    return { nativeSessionId: candidates[0].id, source: "sessions_root_diff", reason: null, path: candidates[0].path };
  }
  return {
    nativeSessionId: null,
    source: null,
    reason: candidates.length > 1 ? "native_session_ambiguous" : "native_session_not_found",
    candidateCount: candidates.length,
  };
}
