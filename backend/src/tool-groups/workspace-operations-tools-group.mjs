/**
 * Workspace operations MCP tool registration group.
 *
 * Extracted from gptwork-server.mjs as part of P4 tool group extraction.
 * URL download, ZIP extraction, and shell execution in the workspace.
 *
 * Dependencies:
 *   tool   - MCP tool factory from tool-registry.mjs
 *   schema - schema factory from mcp-tooling.mjs
 *   store  - StateStore instance
 *   config - RuntimeConfig instance
 */
import {
  workspaceUploadFromUrl,
  workspaceShellZip,
  workspaceShellExec,
} from "../workspace-service.mjs";

export function createWorkspaceOperationsToolsGroup({ tool, schema, store, config }) {
  return {
    upload_from_url: tool("Download a URL and save it to the workspace.", schema({ url: "string", path: "string", overwrite: "boolean", workspace_id: "string" }, ["url", "path"]), async (args, context) => workspaceUploadFromUrl(store, config, args, context)),
    extract_zip_archive: tool("Extract a ZIP archive into a workspace directory.", schema({ zip_path: "string", target_dir: "string", workspace_id: "string" }, ["zip_path"]), async (args, context) => workspaceShellZip(store, config, "extract", args, context)),
    shell_exec: tool("在工作区执行终端命令，用于检查服务状态和运行配置脚本。", schema({ command: "string", cwd: "string", timeout: "integer", max_output_bytes: "integer", workspace_id: "string" }, ["command"]), async (args, context) => workspaceShellExec(store, config, args, context)),
  };
}
