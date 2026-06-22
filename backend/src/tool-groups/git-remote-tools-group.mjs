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
  const common = { modes: ["codex", "full"], audience: ["codex", "operator"], tags: ["git"] };

  return {
    git_remote_resolve_repo: tool({
      name: "git_remote_resolve_repo",
      description: "Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Finds an existing Git checkout for a repo (owner/name, URL, or path). Returns repo_path, remote info, and local/tracking HEADs. Does NOT auto-clone.",
      inputSchema: schema({ repo: "string", repo_path: "string" }, []),
      ...common,
      handler: async (args) => handleResolveRepo(args, context),
    }),
    git_remote_fetch: tool({
      name: "git_remote_fetch",
      description: "Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Runs git fetch to update remote tracking refs from the local Git checkout.",
      inputSchema: schema({ repo: "string", repo_path: "string", remote: "string", branch: "string" }, []),
      ...common,
      handler: async (args) => handleFetch(args, context),
    }),
    git_remote_status: tool({
      name: "git_remote_status",
      description: "Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Returns local HEAD, tracking HEAD, remote HEAD (from git ls-remote), equality flags, and dirty state.",
      inputSchema: schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean" }, []),
      ...common,
      handler: async (args) => handleStatus(args, context),
    }),
    git_remote_list_files: tool({
      name: "git_remote_list_files",
      description: "Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Lists files from a Git ref using git ls-tree --name-only without checking out the ref.",
      inputSchema: schema({ repo: "string", repo_path: "string", ref: "string", path: "string", limit: "integer" }, []),
      ...common,
      handler: async (args) => handleListFiles(args, context),
    }),
    git_remote_read_file: tool({
      name: "git_remote_read_file",
      description: "Use this when the user asks to inspect GitHub remote repository code and GitHub connector is unavailable. Reads file content from a Git ref using git show <ref>:<path> without checking out the ref. Supports truncation via max_bytes.",
      inputSchema: schema({ repo: "string", repo_path: "string", ref: "string", path: "string", max_bytes: "integer" }, ["path"]),
      ...common,
      handler: async (args) => handleReadFile(args, context),
    }),
    git_remote_changed_files: tool({
      name: "git_remote_changed_files",
      description: "Inspect GitHub remote repository changes without GitHub connector. Lists changed files between two refs/commits using git diff --name-status. Supports path scoping and limit.",
      inputSchema: schema({ repo: "string", repo_path: "string", base: "string", head: "string", path: "string", limit: "integer" }, []),
      ...common,
      handler: async (args) => handleChangedFiles(args, context),
    }),
    git_remote_diff: tool({
      name: "git_remote_diff",
      description: "Inspect GitHub remote repository changes without GitHub connector. Returns unified diff between two refs/commits, optionally path-scoped. Truncates safely by max_bytes.",
      inputSchema: schema({
      repo: { type: "string", description: "Repository identifier (owner/name, URL, or configured alias)." },
      repo_path: { type: "string", description: "Path to the local Git checkout." },
      base: { type: "string", description: "Base ref/commit for the diff.", default: "HEAD" },
      head: { type: "string", description: "Head ref/commit for the diff." },
      path: { type: "string", description: "Path scoping for the diff (optional)." },
      max_bytes: { type: "integer", description: "Maximum diff output size in bytes.", minimum: 1024, maximum: 10485760, default: 1048576 }
    }),
      ...common,
      handler: async (args) => handleDiff(args, context),
    }),
    git_remote_show_commit: tool({
      name: "git_remote_show_commit",
      description: "Inspect GitHub remote repository changes without GitHub connector. Shows metadata and file list for one commit/ref using git show --name-status.",
      inputSchema: schema({ repo: "string", repo_path: "string", ref: "string", max_files: "integer" }, []),
      ...common,
      handler: async (args) => handleShowCommit(args, context),
    }),
    git_remote_compare_local: tool({
      name: "git_remote_compare_local",
      description: "Inspect GitHub remote repository changes without GitHub connector. One-shot comparison: returns local HEAD, tracking HEAD, remote HEAD, ahead/behind counts, dirty state, and changed files summary. Fetches remote tracking refs by default.",
      inputSchema: schema({ repo: "string", repo_path: "string", remote: "string", branch: "string", fetch: "boolean", limit: "integer" }, []),
      ...common,
      handler: async (args) => handleCompareLocal(args, context),
    }),
  };
}
