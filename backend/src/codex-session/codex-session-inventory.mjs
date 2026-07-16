import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

function sessionMetaFromText(text) {
  for (const line of String(text || "").split("\n").slice(0, 20)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.type === "session_meta" && value.payload?.id) {
        return {
          id: String(value.payload.id),
          cwd: value.payload.cwd ? String(value.payload.cwd) : null,
          pid: Number.isInteger(value.payload.pid) ? value.payload.pid : null,
          timestamp: value.timestamp || null,
        };
      }
    } catch {
      // Native rollout files are JSONL; ignore unrelated or incomplete lines.
    }
  }
  return { id: null, cwd: null, pid: null, timestamp: null };
}

export async function snapshotNativeSessions(nativeSessionsRoot) {
  const records = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        const text = await readFile(path, "utf8").catch(() => "");
        records.push({ path, size: info.size, mtimeMs: info.mtimeMs, ...sessionMetaFromText(text.slice(0, 64 * 1024)) });
      }
    }
  }
  await walk(nativeSessionsRoot);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
