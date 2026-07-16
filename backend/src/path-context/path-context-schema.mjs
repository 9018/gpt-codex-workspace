export const CODEX_HOME_MODES = Object.freeze(["project", "user", "explicit"]);

export const PATH_CONTEXT_FIELDS = Object.freeze([
  "mcpRoot",
  "projectsRoot",
  "workspaceRoot",
  "projectRoot",
  "canonicalRepoPath",
  "executionCwd",
  "worktreePath",
  "codexHome",
  "nativeSessionsRoot",
  "controlSessionsRoot",
]);

export class PathContextError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "PathContextError";
    this.code = code;
    this.details = details;
  }
}
