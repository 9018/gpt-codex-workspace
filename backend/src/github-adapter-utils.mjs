import { execSync } from "node:child_process";

export function _isTruthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1";
}

/**
 * Parse an owner/repo string from text like:
 *   "repo:9018/gpt-codex-workspace"
 *   "9018/gpt-codex-workspace"
 *   "https://github.com/9018/gpt-codex-workspace"
 *   "git@github.com:9018/gpt-codex-workspace.git"
 * Returns "owner/repo" or null.
 */
export function parseRepo(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const httpsMatch = trimmed.match(/github\.com\/([^/\s]+?\/[^/\s?#]+?)(?:\.git)?(?:\s|$|[?#])/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = trimmed.match(/git@github\.com:([^/\s]+?\/[^/\s]+?)(?:\.git)?(?:\s|$)/);
  if (sshMatch) return sshMatch[1];
  const repoMatch = trimmed.match(/(?:repo:\s*)?([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)(?:\.git)?(?:\s|$)/);
  if (repoMatch) return repoMatch[1];
  return null;
}

/**
 * Parse an issue number from text like: "Issue #1", "#1", "issue 42"
 * Returns the number or null.
 */
export function parseIssueNumber(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/(?:[Ii]ssue\s*)?#?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function hasGit() {
  try { execSync("git --version", { stdio: "pipe", timeout: 5000 }); return true; }
  catch { return false; }
}

export function splitRepo(repoFull) {
  const parts = (repoFull || "").split("/");
  return { owner: parts[0] || "", repo: parts[1] || "" };
}
