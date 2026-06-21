import { mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

function eventPath(workspaceRoot, date = new Date()) {
  return join(workspaceRoot, ".gptwork/events", `${date.toISOString().slice(0, 10)}.jsonl`);
}

export function createEventLogger({ workspaceRoot }) {
  return {
    async append(type, data = {}) {
      const path = eventPath(workspaceRoot);
      await mkdir(join(workspaceRoot, ".gptwork/events"), { recursive: true });
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
