/**
 * event-log-service.mjs — GPTWork event log writer, reader, and rotation.
 */
import { readdir, mkdir, readFile, appendFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

function eventDir(workspaceRoot) {
  return join(workspaceRoot, ".gptwork/events");
}

function eventPath(workspaceRoot, date = new Date()) {
  return join(eventDir(workspaceRoot), `${date.toISOString().slice(0, 10)}.jsonl`);
}

export function createEventLogger({ workspaceRoot }) {
  return {
    async append(type, data = {}) {
      const path = eventPath(workspaceRoot);
      await mkdir(eventDir(workspaceRoot), { recursive: true });
      const event = {
        id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type,
        data,
        created_at: new Date().toISOString(),
      };
      await appendFile(path, JSON.stringify(event) + "\n", "utf8");
      return { event, path };
    },
  };
}

export async function readEvents({ workspaceRoot, date = new Date(), limit = 100 }) {
  const path = eventPath(workspaceRoot, date);
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line));
}

/**
 * Rotate event files, keeping only the last N days.
 *
 * @param {string} workspaceRoot
 * @param {number} [keepDays=7]
 * @returns {Promise<{deleted: number, kept: number, message: string}>}
 */
export async function rotateEvents(workspaceRoot, keepDays = 7) {
  const dir = eventDir(workspaceRoot);
  if (!existsSync(dir)) {
    return { deleted: 0, kept: 0, message: "No events directory." };
  }

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(dir, { withFileTypes: true });
  let deleted = 0;
  let kept = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, entry.name);
    try {
      const s = await stat(fullPath);
      if (s.mtimeMs < cutoff) {
        await rm(fullPath, { force: true });
        deleted++;
      } else {
        kept++;
      }
    } catch {
      kept++;
    }
  }

  return { deleted, kept, message: `Rotated ${deleted} event file(s), kept ${kept}.` };
}
