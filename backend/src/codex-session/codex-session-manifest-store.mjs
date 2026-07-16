import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function safeId(value) {
  const id = String(value || "").trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError("control_session_id must be a safe identifier");
  return id;
}

export function createCodexSessionManifestStore({ projectRoot } = {}) {
  if (!projectRoot) throw new TypeError("projectRoot is required");
  const manifestsRoot = join(projectRoot, ".gptwork", "codex-sessions", "manifests");
  const pathFor = (controlSessionId) => join(manifestsRoot, `${safeId(controlSessionId)}.json`);

  return {
    manifestsRoot,
    async write(manifest = {}) {
      const controlSessionId = safeId(manifest.control_session_id);
      const value = {
        ...manifest,
        control_session_id: controlSessionId,
        updated_at: new Date().toISOString(),
        created_at: manifest.created_at || new Date().toISOString(),
      };
      await mkdir(manifestsRoot, { recursive: true });
      const path = pathFor(controlSessionId);
      const tempPath = `${path}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(tempPath, path);
      return value;
    },
    async read(controlSessionId) {
      return JSON.parse(await readFile(pathFor(controlSessionId), "utf8"));
    },
    async findByNativeSessionId(nativeSessionId) {
      const entries = await readdir(manifestsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const value = JSON.parse(await readFile(join(manifestsRoot, entry.name), "utf8"));
        if (value.native_session_id === nativeSessionId) return value;
      }
      return null;
    },
  };
}
