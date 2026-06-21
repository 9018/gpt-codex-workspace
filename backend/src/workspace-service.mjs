import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLocalShell } from "./local-shell-runner.mjs";
import { DEFAULT_SEARCH_MAX_FILE_BYTES, DEFAULT_SEARCH_MAX_TOTAL_BYTES, looksBinary, normalizeSearchExcludeDirs } from "./workspace-search-helpers.mjs";
import { ensureParent, resolveWorkspacePath } from "./path-utils.mjs";
import { selectWorkspace, requireScope } from "./auth-context.mjs";
import { sha256, shellQuotee } from "./mcp-tooling.mjs";
import { runSshExec, sshListDir, sshReadTextFile, sshDownloadBase64, sshWriteTextFile, sshUploadBase64, sshMkdir, sshDelete, sshMove, sshCopy, sshSha256, sshStat, sshSearchFiles } from "./ssh-adapter.mjs";

export async function writeWorkspaceTextInternal(store, config, workspaceId, path, content, context) {
  return workspaceWriteText(store, config, { path, content, overwrite: true, workspace_id: workspaceId }, context);
}

export async function resolvePath(store, config, args, context) {
  const workspace = await selectWorkspace(store, args.workspace_id, context);
  if (workspace.type === "ssh") {
    const base = workspace.root.replace(/\/+$/, "");
    const target = String(args.path || ".").replace(/\\/g, "/");
    const safePath = (base + "/" + (target === "." ? "" : target)).replace(/\/+/g, "/");
    if (!safePath.startsWith(base)) throw new Error("path is outside workspace root: " + target);
    return { workspace, path: safePath };
 }
 const resolved = await resolveWorkspacePath(workspace.root, args.path || ".");
  return { workspace, path: resolved.absolutePath };
}

export async function workspaceListDir(store, config, { path = ".", recursive = false, limit = 500, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const raw = await sshListDir(workspace, path, 15);
    // Parse ls -la output into structured items for consistency with hosted
    const items = [];
    for (const line of (raw.stdout || "").split("\n")) {
      if (items.length >= limit) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("total ") || trimmed.startsWith("d********")) continue;
      // Parse typical ls -la line: permissions links owner group size date name
      const parts = trimmed.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;
      const type = parts[0].startsWith("d") ? "directory" : "file";
      const size = parseInt(parts[4], 10) || 0;
      items.push({ path: name, name, type, size, modified_at: parts[5] + " " + parts[6] + " " + parts[7] });
    }
    return { path, recursive, count: items.length, limit, items, raw: { returncode: raw.returncode, stdout: raw.stdout, stderr: raw.stderr } };
  }
  const items = [];
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (items.length >= limit) return;
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      const childAbs = join(abs, entry.name);
      const childStat = await stat(childAbs);
      items.push({ path: childRel, name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: childStat.size, modified_at: childStat.mtime.toISOString() });
      if (recursive && entry.isDirectory()) await walk(childAbs, childRel);
    }
  }
  await walk(resolvedPath, path);
  return { path, recursive, count: items.length, limit, items };
}

export async function workspaceStat(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshStat(workspace, resolvedPath, 10);
  const item = await stat(resolvedPath);
  return { path: args.path, type: item.isDirectory() ? "directory" : "file", size: item.size, modified_at: item.mtime.toISOString() };
}

export async function workspaceReadText(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshReadTextFile(workspace, resolvedPath, 15);
    const max = max_bytes || config.maxReadBytes;
    return { path, size: result.stdout.length, truncated: Buffer.byteLength(result.stdout) > max, content: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content: bytes.subarray(0, max).toString("utf8") };
}

export async function workspaceDownloadBase64(store, config, { path, max_bytes, workspace_id }, context) {
  requireScope(context, "files:download");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") {
    const result = await sshDownloadBase64(workspace, resolvedPath, 30);
    const max = max_bytes || config.maxReadBytes;
    return { path, truncated: result.stdout.length > max, content_base64: result.stdout.slice(0, max) };
  }
  const bytes = await readFile(resolvedPath);
  const max = max_bytes || config.maxReadBytes;
  return { path, size: bytes.length, truncated: bytes.length > max, content_base64: bytes.subarray(0, max).toString("base64") };
}

export async function workspaceWriteText(store, config, { path, content, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshWriteTextFile(workspace, resolvedPath, content, 30);
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content, "utf8");
  return { ok: true, path, size: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) };
}

export async function workspaceUploadBase64(store, config, { path, content_base64, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshUploadBase64(workspace, resolvedPath, content_base64, 60);
  const content = Buffer.from(content_base64, "base64");
  if (!overwrite) {
    try {
      await stat(resolvedPath);
      throw new Error("file exists: " + path);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(resolvedPath);
  await writeFile(resolvedPath, content);
  return { ok: true, path, size: content.length, sha256: sha256(content) };
}

export async function workspaceUploadFromUrl(store, config, { url, path, overwrite = false, workspace_id }, context) {
  requireScope(context, "files:upload");
  const response = await fetch(url);
  if (!response.ok) throw new Error("download failed: " + response.status);
  const content = Buffer.from(await response.arrayBuffer());
  return workspaceUploadBase64(store, config, { path, content_base64: content.toString("base64"), overwrite, workspace_id }, context);
}

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

const DEFAULT_BUNDLE_MAX_BYTES = 25 * 1024 * 1024;

export async function workspaceDownloadBundleBase64(store, config, { source_dir = "", paths = [], max_bytes = DEFAULT_BUNDLE_MAX_BYTES, max_bundle_bytes, workspace_id }, context) {
  requireScope(context, "files:download");
  const workspace = await selectWorkspace(store, workspace_id, context);
  if (workspace.type === "ssh") throw new Error("download_bundle_base64 currently supports hosted workspaces only");
  const tmpRoot = await mkdtemp(join(tmpdir(), "gptwork-bundle-"));
  const bundlePath = join(tmpRoot, "bundle.zip");
  const source = source_dir || ".";
  const hasExplicitBundleCap = max_bundle_bytes !== undefined && max_bundle_bytes !== null;
  const maxBytes = Math.max(1, Number(hasExplicitBundleCap ? max_bundle_bytes : max_bytes) || DEFAULT_BUNDLE_MAX_BYTES);
  try {
    if (Array.isArray(paths) && paths.length) {
      const staging = join(tmpRoot, "staging");
      await mkdir(staging, { recursive: true });
      for (const item of paths) {
        const resolved = await resolveWorkspacePath(workspace.root, item);
        const target = join(staging, resolved.relativePath);
        await ensureParent(target);
        await cp(resolved.absolutePath, target, { recursive: true, force: true });
      }
      await runZipCommand("create", staging, bundlePath, config.pythonCommand);
    } else {
      const resolved = await resolveWorkspacePath(workspace.root, source);
      await runZipCommand("create", resolved.absolutePath, bundlePath, config.pythonCommand);
    }
    const bytes = await readFile(bundlePath);
    if (bytes.length > maxBytes) {
      if (hasExplicitBundleCap) {
        return { ok: false, error: "too_large", too_large: true, source_dir: source, paths, size: bytes.length, max_bundle_bytes: maxBytes };
      }
      throw new Error(`bundle too large: ${bytes.length} bytes exceeds max_bytes ${maxBytes}`);
    }
    return { ok: true, source_dir: source, paths, size: bytes.length, sha256: sha256(bytes), zip_base64: bytes.toString("base64") };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function workspaceMkdir(store, config, args, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") return sshMkdir(workspace, resolvedPath, 10);
  await mkdir(resolvedPath, { recursive: true });
  return { ok: true, path: args.path };
}

export async function workspaceDelete(store, config, { path, recursive = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context);
  if (workspace.type === "ssh") return sshDelete(workspace, resolvedPath, recursive, 15);
  await rm(resolvedPath, { recursive, force: false });
  return { ok: true, deleted: path, permanent: true };
}

export async function workspaceMove(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshMove(workspace, srcPath, dstPath, 15);
  if (!overwrite) {
    try {
      await stat(dstPath);
      throw new Error("destination exists: " + dst);
    } catch (error) {
      if (!/ENOENT/.test(error.code || "")) throw error;
    }
  }
  await ensureParent(dstPath);
  await rename(srcPath, dstPath);
  return { ok: true, src, dst };
}

export async function workspaceCopy(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context);
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context);
  if (workspace.type === "ssh") return sshCopy(workspace, srcPath, dstPath, 30);
  await ensureParent(dstPath);
  await cp(srcPath, dstPath, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  return { ok: true, src, dst };
}

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

export async function workspaceSha256(store, config, args, context) {
  requireScope(context, "workspace:read");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context);
  if (workspace.type === "ssh") {
    const hash = await sshSha256(workspace, resolvedPath, 15);
    return { path: args.path, sha256: hash };
  }
  const bytes = await readFile(resolvedPath);
  return { path: args.path, size: bytes.length, sha256: sha256(bytes) };
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

export async function runZipCommand(mode, sourcePath, zipPath, pythonCommand = process.platform === "win32" ? "python" : "python3") {
  const command = mode === "create"
    ? pythonCommand + " -m zipfile -c " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath)
    : pythonCommand + " -m zipfile -e " + shellQuotee(zipPath) + " " + shellQuotee(sourcePath);
  const result = await runLocalShell(command, dirname(zipPath), 60, 1000000);
  if (result.returncode !== 0) throw new Error(`zip command failed: ${result.stderr || result.stdout}`);
  return result;
}

export { runLocalShell };
