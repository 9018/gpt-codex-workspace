import {
  workspaceWriteText,
  workspaceUploadBase64,
  workspaceUploadBundleBase64,
  workspaceMkdir,
  workspaceDelete,
  workspaceMove,
  workspaceCopy,
  workspaceShellZip,
} from "../workspace-service.mjs";

/**
 * Scoped MCP tool group: workspace mutation/upload/archive tools.
 * Handlers delegate to workspace-service.mjs for path safety, overwrite behavior,
 * recursive delete, auth context behavior, and response shapes.
 */
export function createWorkspaceMutationToolsGroup({ tool, schema, store, config }) {
  return {
    write_text_file: tool("Write a UTF-8 text file.", schema({ path: "string", content: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content"]), async (args, context) => workspaceWriteText(store, config, args, context)),
    upload_base64_file: tool("Upload a base64 encoded file.", schema({ path: "string", content_base64: "string", overwrite: "boolean", workspace_id: "string" }, ["path", "content_base64"]), async (args, context) => workspaceUploadBase64(store, config, args, context)),
    upload_bundle_base64: tool("Upload a ZIP bundle encoded as base64. Optionally extract it in the workspace after upload.", schema({ path: "string", zip_base64: "string", overwrite: "boolean", extract: "boolean", target_dir: "string", sha256_expected: "string", workspace_id: "string" }, ["path", "zip_base64"]), async (args, context) => workspaceUploadBundleBase64(store, config, args, context)),
    mkdir: tool("Create a directory.", schema({ path: "string", workspace_id: "string" }, ["path"]), async (args, context) => workspaceMkdir(store, config, args, context)),
    delete_path: tool("Permanently delete a file or directory. Files are deleted immediately, without recycle/trash. Use with caution.", schema({ path: "string", recursive: "boolean", workspace_id: "string" }, ["path"]), async (args, context) => workspaceDelete(store, config, args, context)),
    move_path: tool("Move or rename a file/directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceMove(store, config, args, context)),
    copy_path: tool("Copy a file or directory.", schema({ src: "string", dst: "string", overwrite: "boolean", workspace_id: "string" }, ["src", "dst"]), async (args, context) => workspaceCopy(store, config, args, context)),
    create_zip_archive: tool("Create a ZIP archive from a directory.", schema({ source_dir: "string", zip_path: "string", workspace_id: "string" }, ["source_dir", "zip_path"]), async (args, context) => workspaceShellZip(store, config, "create", args, context)),
  };
}
