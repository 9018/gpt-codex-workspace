import { workspaceListDir, workspaceStat, workspaceReadText, workspaceDownloadBase64, workspaceDownloadBundleBase64, workspaceSearch, workspaceSha256 } from "../workspace-service.mjs";

/**
 * Scoped MCP tool group: read-only workspace filesystem tools.
 * Handlers delegate to workspace-service.mjs for path safety, max byte limits,
 * auth context behavior, and response shapes.
 */
export function createWorkspaceReadToolsGroup({ tool, schema, store, config }) {
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex", "operator"], tags: ["workspace"] };
  return {
    list_dir: tool({
      name: "list_dir",
      description: "List files and directories under a workspace path.",
      inputSchema: schema({ path: "string", recursive: "boolean", limit: "integer", workspace_id: "string" }),
      ...common,
      handler: async (args, context) => workspaceListDir(store, config, args, context),
    }),
    stat_path: tool({
      name: "stat_path",
      description: "Return metadata for a file or directory.",
      inputSchema: schema({ path: "string", workspace_id: "string" }, ["path"]),
      ...common,
      handler: async (args, context) => workspaceStat(store, config, args, context),
    }),
    read_text_file: tool({
      name: "read_text_file",
      description: "Read a UTF-8 text file.",
      inputSchema: schema({
      path: { type: "string", description: "Path to the file to read (relative to workspace root)." },
      max_bytes: { type: "integer", description: "Maximum bytes to read. Truncates larger files.", minimum: 256, maximum: 10485760, default: 1048576 },
      workspace_id: { type: "string", description: "Workspace ID." }
    }, ["path"]),
      ...common,
      handler: async (args, context) => workspaceReadText(store, config, args, context),
    }),
    download_file_base64: tool({
      name: "download_file_base64",
      description: "Download a file as base64.",
      inputSchema: schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]),
      ...common,
      handler: async (args, context) => workspaceDownloadBase64(store, config, args, context),
    }),
    download_bundle_base64: tool({
      name: "download_bundle_base64",
      description: "Create a ZIP bundle from a workspace directory or selected paths and return it as base64 with a SHA256 digest.",
      inputSchema: schema({ source_dir: "string", paths: "array", max_bytes: "integer", max_bundle_bytes: "integer", workspace_id: "string" }, []),
      ...common,
      tags: ["workspace", "bundle"],
      handler: async (args, context) => workspaceDownloadBundleBase64(store, config, args, context),
    }),
    search_files: tool({
      name: "search_files",
      description: "Search text content and file names under a directory.",
      inputSchema: schema({
      q: { type: "string", description: "Search query (text to search for in file contents and names)." },
      path: { type: "string", description: "Directory path to search under.", default: "." },
      limit: { type: "integer", description: "Maximum number of results.", minimum: 1, maximum: 500, default: 50 },
      exclude_dirs: { type: "array", description: "Directory names to exclude (e.g. node_modules, .git).", items: { type: "string" }, examples: [["node_modules", ".git", "dist"]] },
      max_file_bytes: { type: "integer", description: "Skip files larger than this.", minimum: 1024, maximum: 10485760, default: 1048576 },
      max_total_bytes: { type: "integer", description: "Maximum total bytes to scan across all files.", minimum: 10240, maximum: 52428800, default: 10485760 },
      workspace_id: { type: "string", description: "Workspace ID." }
    }, ["q"]),
      ...common,
      handler: async (args, context) => workspaceSearch(store, config, args, context),
    }),
    sha256_file: tool({
      name: "sha256_file",
      description: "Calculate SHA256 of a file.",
      inputSchema: schema({ path: "string", workspace_id: "string" }, ["path"]),
      ...common,
      tags: ["workspace", "checksum"],
      handler: async (args, context) => workspaceSha256(store, config, args, context),
    }),
  };
}
