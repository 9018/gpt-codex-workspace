import { workspaceListDir, workspaceStat, workspaceReadText, workspaceDownloadBase64, workspaceDownloadBundleBase64, workspaceSearch, workspaceSha256 } from "../workspace-service.mjs";

/**
 * Scoped MCP tool group: read-only workspace filesystem tools.
 * Handlers delegate to workspace-service.mjs for path safety, max byte limits,
 * auth context behavior, and response shapes.
 */
export function createWorkspaceReadToolsGroup({ tool, schema, store, config }) {
  return {
    list_dir: tool("List files and directories under a workspace path.", schema({ path: "string", recursive: "boolean", limit: "integer", workspace_id: "string" }), async (args, context) => workspaceListDir(store, config, args, context)),
    stat_path: tool("Return metadata for a file or directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceStat(store, config, args, context)),
    read_text_file: tool("Read a UTF-8 text file.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceReadText(store, config, args, context)),
    download_file_base64: tool("Download a file as base64.", schema({ path: "string", max_bytes: "integer", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDownloadBase64(store, config, args, context)),
    download_bundle_base64: tool("Create a ZIP bundle from a workspace directory or selected paths and return it as base64 with a SHA256 digest.", schema({ source_dir: "string", paths: "array", max_bytes: "integer", max_bundle_bytes: "integer", workspace_id: "string" }, []), async (args, context) => workspaceDownloadBundleBase64(store, config, args, context)),
    search_files: tool("Search text content and file names under a directory.", schema({ q: "string", path: "string", limit: "integer", exclude_dirs: "array", max_file_bytes: "integer", max_total_bytes: "integer", workspace_id: "string" }, ["q"]), async (args, context) => workspaceSearch(store, config, args, context)),
    sha256_file: tool("Calculate SHA256 of a file.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceSha256(store, config, args, context)),
  };
}
