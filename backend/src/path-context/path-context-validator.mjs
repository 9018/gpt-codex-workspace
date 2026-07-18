import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { PathContextError } from "./path-context-schema.mjs";

function realpathOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function gitCommonDir(path) {
  try {
    return realpathOrResolved(execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim());
  } catch {
    return null;
  }
}

export function validatePathContext(input = {}) {
  const context = { ...input };
  if (!context.projectRoot || !context.canonicalRepoPath) {
    throw new PathContextError("project_root_unresolved", "projectRoot and canonicalRepoPath are required");
  }

  context.projectRoot = realpathOrResolved(context.projectRoot);
  context.canonicalRepoPath = realpathOrResolved(context.canonicalRepoPath);
  for (const field of ["mcpRoot", "projectsRoot", "workspaceRoot"]) {
    if (context[field]) context[field] = realpathOrResolved(context[field]);
  }
  const canonicalGitDir = gitCommonDir(context.canonicalRepoPath);
  if (!canonicalGitDir) {
    throw new PathContextError("canonical_repo_not_git", `canonical repository is not a Git checkout: ${context.canonicalRepoPath}`);
  }
  if (context.projectRoot !== context.canonicalRepoPath) {
    throw new PathContextError("project_root_mismatch", "projectRoot must equal canonicalRepoPath");
  }
  if (context.projectsRoot && context.projectsRoot === context.projectRoot) {
    throw new PathContextError("projects_root_is_project_root", "projectsRoot must be a container, not the projectRoot");
  }

  if (context.worktreePath) {
    context.worktreePath = realpathOrResolved(context.worktreePath);
    const worktreeGitDir = gitCommonDir(context.worktreePath);
    if (!worktreeGitDir || worktreeGitDir !== canonicalGitDir) {
      throw new PathContextError("worktree_repo_mismatch", "worktreePath is not attached to canonicalRepoPath");
    }
  }

  context.executionCwd = realpathOrResolved(context.executionCwd || context.worktreePath || context.projectRoot);
  const validExecutionCwd = context.executionCwd === context.projectRoot
    || (context.worktreePath && context.executionCwd === context.worktreePath);
  if (!validExecutionCwd) {
    throw new PathContextError("execution_cwd_invalid", "executionCwd must be the canonical repository or validated worktree");
  }

  const expectedControlSessionsRoot = join(context.projectRoot, ".gptwork", "codex-sessions");
  if (context.controlSessionsRoot && resolve(context.controlSessionsRoot) !== expectedControlSessionsRoot) {
    throw new PathContextError("control_sessions_root_invalid", "controlSessionsRoot must be project scoped");
  }
  context.controlSessionsRoot = expectedControlSessionsRoot;
  return context;
}
