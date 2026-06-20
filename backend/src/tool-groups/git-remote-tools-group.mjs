import {
  handleResolveRepo,
  handleFetch,
  handleStatus,
  handleListFiles,
  handleReadFile,
  handleChangedFiles,
  handleDiff,
  handleShowCommit,
  handleCompareLocal,
} from "../git-remote-tools.mjs";

/**
 * Scoped MCP tool group: Git remote inspection tools.
 * Handlers inspect GitHub remote repository state through local Git tracking refs
 * without requiring a GitHub MCP connector.
 */
export function createGitRemoteToolsGroup({ tool, schema, registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote }) {
  const context = { registry, defaultWorkspaceRoot, defaultRepo, defaultBranch, defaultRepoPath, defaultRemote };

  return {
    git_remote_resolve_repo: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Finds an existing Git checkout for a repo (owner/name, URL, or path). Returns repo_path, remote info, and local/tracking HEADs. Does NOT auto-clone.", schema({ repo: "string", repo_path: "string" }, []), async (args) => handleResolveRepo(args, context)),
    git_remote_fetch: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Runs git fetch to update remote tracking refs from the local Git checkout.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string" }, []), async (args) => handleFetch(args, context)),
    git_remote_status: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Returns local HEAD, tracking HEAD, remote HEAD (from git ls-remote), equality flags, and dirty state.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean" }, []), async (args) => handleStatus(args, context)),
    git_remote_list_files: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Lists files from a Git ref using git ls-tree --name-only without checking out the ref.", schema({ repo: "string", repo_path: "string", ref: "string", path: "string", limit: "integer" }, []), async (args) => handleListFiles(args, context)),
    git_remote_read_file: tool("Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Reads file content from a Git ref using git show <ref>:<path> without checking out the ref. Supports truncation via max_bytes.", schema({ repo: "string", repo_path: "string", ref: "string", path: "string", max_bytes: "integer" }, ["path"]), async (args) => handleReadFile(args, context)),
    git_remote_changed_files: tool("Inspect GitHub remote repository changes without GitHub connector. Lists changed files between two refs/commits using git diff --name-status. Supports path scoping and limit.", schema({ repo: "string", repo_path: "string", base: "string", head: "string", path: "string", limit: "integer" }, []), async (args) => handleChangedFiles(args, context)),
    git_remote_diff: tool("Inspect GitHub remote repository changes without GitHub connector. Returns unified diff between two refs/commits, optionally path-scoped. Truncates safely by max_bytes.", schema({ repo: "string", repo_path: "string", base: "string", head: "string", path: "string", max_bytes: "integer" }, []), async (args) => handleDiff(args, context)),
    git_remote_show_commit: tool("Inspect GitHub remote repository changes without GitHub connector. Shows metadata and file list for one commit/ref using git show --name-status.", schema({ repo: "string", repo_path: "string", ref: "string", max_files: "integer" }, []), async (args) => handleShowCommit(args, context)),
    git_remote_compare_local: tool("Inspect GitHub remote repository changes without GitHub connector. One-shot comparison: returns local HEAD, tracking HEAD, remote HEAD, ahead/behind counts, dirty state, and changed files summary. Fetches remote tracking refs by default.", schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean", limit: "integer" }, []), async (args) => handleCompareLocal(args, context)),
  };
}
