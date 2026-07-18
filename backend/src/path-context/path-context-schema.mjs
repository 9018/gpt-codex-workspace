export const PATH_CONTEXT_FIELDS = Object.freeze([
  "mcpRoot", "projectsRoot", "workspaceRoot", "projectRoot",
  "canonicalRepoPath", "executionCwd", "worktreePath", "controlSessionsRoot",
]);

export class PathContextError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "PathContextError";
    this.code = code;
    this.details = details;
  }
}
