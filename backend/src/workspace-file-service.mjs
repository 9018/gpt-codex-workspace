import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceGuard, matchesBlockedGlob } from "./workspace-guard.mjs";
import { ensureParent, resolveWorkspacePath } from "./path-utils.mjs";
import { selectWorkspace, requireScope } from "./auth-context.mjs";
import { sha256 } from "./mcp-tooling.mjs";
import { sshListDir, sshReadTextFile, sshDownloadBase64, sshWriteTextFile, sshUploadBase64, sshMkdir, sshDelete, sshMove, sshCopy, sshSha256, sshStat } from "./ssh-adapter.mjs";

export async function writeWorkspaceTextInternal(store, config, workspaceId, path, content, context) {
  return workspaceWriteText(store, config, { path, content, overwrite: true, workspace_id: workspaceId }, context);
}

export async function resolvePath(store, config, args, context, operation = "read") {
  const workspace = await selectWorkspace(store, args.workspace_id, context);
  if (workspace.type === "ssh") {
    const base = workspace.root.replace(/\/+$/, "");
    const target = String(args.path || ".").replace(/\\/g, "/");
    const safePath = (base + "/" + (target === "." ? "" : target)).replace(/\/+/g, "/");
    if (!safePath.startsWith(base)) throw new Error("path is outside workspace root: " + target);
    return { workspace, path: safePath };
  }
  const resolved = await resolveWorkspacePath(workspace.root, args.path || ".");
  // Apply workspace guard checks
  const guard = createWorkspaceGuard(config);
  const isWrite = operation === "write";
  guard.assertAllowedPath(resolved.absolutePath, { operation, isWrite });
  await guard.assertRealPathInsideWorkspace(resolved.absolutePath);
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
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context, "write");
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
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context, "write");
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

export async function workspaceMkdir(store, config, args, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, args, context, "write");
  if (workspace.type === "ssh") return sshMkdir(workspace, resolvedPath, 10);
  await mkdir(resolvedPath, { recursive: true });
  return { ok: true, path: args.path };
}

export async function workspaceDelete(store, config, { path, recursive = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: resolvedPath } = await resolvePath(store, config, { path, workspace_id }, context, "write");
  if (workspace.type === "ssh") return sshDelete(workspace, resolvedPath, recursive, 15);
  await rm(resolvedPath, { recursive, force: false });
  return { ok: true, deleted: path, permanent: true };
}

export async function workspaceMove(store, config, { src, dst, overwrite = false, workspace_id }, context) {
  requireScope(context, "workspace:write");
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context, "write");
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context, "write");
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
  const { workspace, path: srcPath } = await resolvePath(store, config, { path: src, workspace_id }, context, "write");
  const { path: dstPath } = await resolvePath(store, config, { path: dst, workspace_id }, context, "write");
  if (workspace.type === "ssh") return sshCopy(workspace, srcPath, dstPath, 30);
  await ensureParent(dstPath);
  await cp(srcPath, dstPath, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  return { ok: true, src, dst };
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
