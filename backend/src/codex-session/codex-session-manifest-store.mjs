import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
    async list() {
      const entries = await readdir(manifestsRoot, { withFileTypes: true }).catch(() => []);
      const values = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        values.push(JSON.parse(await readFile(join(manifestsRoot, entry.name), "utf8")));
      }
      return values.sort((a, b) => String(a.control_session_id).localeCompare(String(b.control_session_id)));
    },
    async findByNativeSessionId(nativeSessionId) {
      for (const value of await this.list()) {
        if (value.native_session_id === nativeSessionId) return value;
      }
      return null;
    },
    async delete(controlSessionId) {
      await rm(pathFor(controlSessionId), { force: true });
    },
    async update(controlSessionId, patch = {}) {
      const current = await this.read(controlSessionId);
      return this.write({ ...current, ...patch, control_session_id: current.control_session_id, created_at: current.created_at });
    },
  };
}
