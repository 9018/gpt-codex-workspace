import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runLocalShell } from "./local-shell-runner.mjs";
import { runZipCommand } from "./workspace-zip-runner.mjs";
import { resolvePath, workspaceUploadBase64 } from "./workspace-file-service.mjs";
import { selectWorkspace, requireScope } from "./auth-context.mjs";
import { shellQuotee } from "./mcp-tooling.mjs";
import { runSshExec } from "./ssh-adapter.mjs";

export { writeWorkspaceTextInternal, resolvePath, workspaceListDir, workspaceStat, workspaceReadText, workspaceDownloadBase64, workspaceWriteText, workspaceUploadBase64, workspaceUploadFromUrl, workspaceMkdir, workspaceDelete, workspaceMove, workspaceCopy, workspaceSha256 } from "./workspace-file-service.mjs";

export async function workspaceUploadBundleBase64(store, config, { path, zip_base64, overwrite = false, extract = false, target_dir = "", sha256_expected = "", workspace_id }, context) {
  requireScope(context, "files:upload");
  const uploaded = await workspaceUploadBase64(store, config, { path, content_base64: zip_base64, overwrite, workspace_id }, context);
  if (sha256_expected && uploaded.sha256 !== sha256_expected) throw new Error(`bundle sha256 mismatch: expected ${sha256_expected}, got ${uploaded.sha256}`);
  let extracted = null;
  if (extract) {
    extracted = await workspaceShellZip(store, config, "extract", { zip_path: path, target_dir: target_dir || dirname(path), workspace_id }, context);
  }
  return { ok: true, path, size: uploaded.size, sha256: uploaded.sha256, extracted };
}

export { workspaceDownloadBundleBase64 } from "./workspace-bundle-service.mjs";

export { workspaceSearch } from "./workspace-search-service.mjs";

export async function workspaceShellExec(store, config, { command, cwd = ".", timeout, max_output_bytes, workspace_id }, context) {
  requireScope(context, "shell:exec");
  const workspace = await selectWorkspace(store, workspace_id, context);
  const sshCwd = cwd === "." ? "." : cwd.replace(/\\/g, "/");
  if (workspace.type === "ssh") return runSshExec(workspace, command, sshCwd, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
  const { path: resolvedPath } = await resolvePath(store, config, { path: cwd || ".", workspace_id }, context);
  await mkdir(resolvedPath, { recursive: true });
  return runLocalShell(command, resolvedPath, timeout || config.shellTimeout, max_output_bytes || config.maxShellOutputBytes);
}

export async function workspaceShellZip(store, config, mode, args, context) {
  const command = mode === "create"
    ? config.pythonCommand + " -m zipfile -c " + shellQuotee(args.zip_path) + " " + shellQuotee(args.source_dir)
    : config.pythonCommand + " -m zipfile -e " + shellQuotee(args.zip_path) + " " + shellQuotee(args.target_dir || ".");
  return workspaceShellExec(store, config, { command, cwd: ".", workspace_id: args.workspace_id }, context);
}

export { runLocalShell };
