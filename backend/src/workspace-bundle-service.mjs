import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runZipCommand } from "./workspace-zip-runner.mjs";
import { ensureParent, resolveWorkspacePath } from "./path-utils.mjs";
import { selectWorkspace, requireScope } from "./auth-context.mjs";
import { sha256 } from "./mcp-tooling.mjs";

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
