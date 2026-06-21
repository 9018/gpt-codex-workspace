import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runLocalShell } from "./local-shell-runner.mjs";
import { runZipCommand } from "./workspace-zip-runner.mjs";
import { DEFAULT_SEARCH_MAX_FILE_BYTES, DEFAULT_SEARCH_MAX_TOTAL_BYTES, looksBinary, normalizeSearchExcludeDirs } from "./workspace-search-helpers.mjs";
import { resolvePath, workspaceUploadBase64 } from "./workspace-file-service.mjs";
import { selectWorkspace, requireScope } from "./auth-context.mjs";
import { shellQuotee } from "./mcp-tooling.mjs";
import { runSshExec, sshSearchFiles } from "./ssh-adapter.mjs";

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

export async function workspaceSearch(store, config, { q, path = ".", limit = 50, exclude_dirs = [], max_file_bytes = DEFAULT_SEARCH_MAX_FILE_BYTES, max_total_bytes = DEFAULT_SEARCH_MAX_TOTAL_BYTES, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  const maxResults = Math.max(1, Math.min(Number(limit) || 50, 500));
  const maxFileBytes = Math.max(0, Number(max_file_bytes) || DEFAULT_SEARCH_MAX_FILE_BYTES);
  const maxTotalBytes = Math.max(0, Number(max_total_bytes) || DEFAULT_SEARCH_MAX_TOTAL_BYTES);
  const excludeDirs = normalizeSearchExcludeDirs(exclude_dirs);
  if (workspace.type === "ssh") {
    const raw = await sshSearchFiles(workspace, q, resolvedPath, 60, maxResults, { maxFileBytes, maxTotalBytes, excludeDirs: [...excludeDirs] });
    const paths = (raw.stdout || "").trim().split("\n").filter(Boolean).slice(0, maxResults);
    const results = paths.map((p) => ({ path: p, matched_name: true, matched_content: true, snippet: "" }));
    return { q, path, count: results.length, results, max_total_bytes: maxTotalBytes, raw: { returncode: raw.returncode, stdout: raw.stdout, stderr: raw.stderr } };
  }
  const results = [];
  let scannedBytes = 0;
  let skippedBinary = 0;
  let skippedTotalBytes = false;
  async function walk(abs, rel) {
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || excludeDirs.has(childRel)) continue;
        await walk(childAbs, childRel);
      }
      else {
        const matchedName = childRel.includes(q);
        const info = await stat(childAbs);
        let text = "";
        let idx = -1;
        if (info.size <= maxFileBytes) {
          const bytes = await readFile(childAbs);
          if (scannedBytes + bytes.length > maxTotalBytes) {
            skippedTotalBytes = true;
            return;
          }
          scannedBytes += bytes.length;
          if (looksBinary(bytes)) {
            skippedBinary += 1;
          } else {
            text = bytes.toString("utf8");
            idx = text.indexOf(q);
          }
        }
        if (matchedName || idx !== -1) {
          results.push({ path: childRel, size: info.size, matched_name: matchedName, matched_content: idx !== -1, snippet: idx === -1 ? "" : text.slice(Math.max(0, idx - 40), idx + q.length + 40) });
        }
      }
    }
  }
  await walk(resolvedPath, path);
  return { q, path, count: results.length, results, scanned_bytes: scannedBytes, max_total_bytes: maxTotalBytes, skipped_binary: skippedBinary, skipped_total_bytes: skippedTotalBytes, truncated: skippedTotalBytes || results.length >= maxResults };
}

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
