import { join, resolve } from "node:path";

import { resolveCodexHome, normalizeCodexHomeMode } from "./codex-home-resolver.mjs";
import { PathContextError } from "./path-context-schema.mjs";
import { validatePathContext } from "./path-context-validator.mjs";

function firstPath(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return resolve(value.trim());
  }
  return null;
}

function firstContainerPath(projectRoot, ...values) {
  const resolvedProjectRoot = resolve(projectRoot);
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = resolve(value.trim());
    if (candidate !== resolvedProjectRoot) return candidate;
  }
  return resolve(resolvedProjectRoot, "..");
}

function taskCanonicalRepoPath(task = {}) {
  return firstPath(
    task.canonical_repo_path,
    task.repo_resolution?.canonical_repo_path,
    task.result?.repo_resolution?.canonical_repo_path,
    task.result?.execution_cwd_proof?.canonical_repo_path,
  );
}

function taskWorktreePath(task = {}) {
  return firstPath(
    task.worktree_path,
    task.task_worktree_path,
    task.repo_resolution?.task_worktree_path,
    task.result?.repo_resolution?.task_worktree_path,
    task.result?.worktree_lifecycle?.worktree_path,
  );
}

export async function resolvePathContext({
  mcpRoot = null,
  projectsRoot = null,
  workspaceRoot = null,
  task = {},
  repository = null,
  config = {},
} = {}) {
  const canonicalRepoPath = firstPath(
    taskCanonicalRepoPath(task),
    repository?.canonical_path,
    repository?.canonicalRepoPath,
    config.projectRoot,
    config.explicitProjectRoot,
    config.defaultRepoPath,
  );
  if (!canonicalRepoPath) {
    throw new PathContextError("project_root_unresolved", "No task, repository, project config, or default repository resolved a project root");
  }

  const worktreePath = taskWorktreePath(task);
  const codexHomeMode = normalizeCodexHomeMode(config.codexHomeMode || config.codex_home_mode || "project");
  const codexHome = resolveCodexHome({
    projectRoot: canonicalRepoPath,
    mode: codexHomeMode,
    explicitPath: config.codexHome,
  });
  const projectParent = resolve(canonicalRepoPath, "..");

  return validatePathContext({
    mcpRoot: firstPath(mcpRoot, config.mcpRoot, projectParent),
    projectsRoot: firstContainerPath(canonicalRepoPath, projectsRoot, config.projectsRoot, workspaceRoot, projectParent),
    workspaceRoot: firstPath(workspaceRoot, config.defaultWorkspaceRoot, config.workspaceRoot, projectParent),
    projectRoot: canonicalRepoPath,
    canonicalRepoPath,
    executionCwd: worktreePath || canonicalRepoPath,
    worktreePath,
    codexHome,
    nativeSessionsRoot: join(codexHome, "sessions"),
    controlSessionsRoot: join(canonicalRepoPath, ".gptwork", "codex-sessions"),
    codexHomeMode,
  });
}
