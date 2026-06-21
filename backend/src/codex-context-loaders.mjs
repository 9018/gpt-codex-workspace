import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadProjectEnv(repoPath) {
  if (!repoPath) return { ok: false, path: null, vars: {}, keys: [] };
  const filePath = join(repoPath, ".gptwork", "project.env");
  try {
    const text = await readFile(filePath, "utf8");
    const vars = {};
    const keys = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim();
      if (!k) continue;
      vars[k] = v;
      keys.push(k);
    }
    return { ok: true, path: filePath, vars, keys };
  } catch {
    return { ok: false, path: null, vars: {}, keys: [] };
  }
}

/**
 * Load project-level .gptwork/project.md from canonical repo path.
 *
 * @param {string} repoPath - Absolute path to the canonical repo clone.
 * @returns {{ ok: boolean, path: string|null, content: string|null, size: number }}
 */
export async function loadProjectMd(repoPath) {
  if (!repoPath) return { ok: false, path: null, content: null, size: 0 };
  const filePath = join(repoPath, ".gptwork", "project.md");
  try {
    const bytes = await readFile(filePath);
    return { ok: true, path: filePath, content: bytes.toString("utf8"), size: bytes.length };
  } catch {
    return { ok: false, path: null, content: null, size: 0 };
  }
}

// ---------------------------------------------------------------------------
// Workspace file helpers
// ---------------------------------------------------------------------------

/**
 * Get a human-readable file size string.
 */
