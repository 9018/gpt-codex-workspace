import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { requireScope, defaultTokenContext } from '../auth-context.mjs';
import { extractTaskLimit } from '../task-status.mjs';
import { emitTaskProgress, updateTask } from '../task-lifecycle.mjs';

function validateDateSegment(value) {
  const text = String(value || "").trim();
  if (!/^\d{2,4}$/.test(text)) throw new Error("invalid date segment");
  return text;
}

export async function listCodexSessionsMetadata(config, { year = "", month = "", day = "", limit = 50 }, context) {
  requireScope(context, "workspace:read");
  const sessionsRoot = join(config.codexHome, ".codex", "sessions");
  const parts = [year, month, day].filter(Boolean).map(validateDateSegment);
  const targetRoot = join(sessionsRoot, ...parts);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  const sessions = [];

  async function walk(dir) {
    if (sessions.length >= maxItems) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sessions.length >= maxItems) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const item = await stat(child);
        sessions.push({
          name: entry.name,
          relative_path: relative(sessionsRoot, child).replaceAll("\\", "/"),
          size: item.size,
          modified_at: item.mtime.toISOString()
        });
      }
    }
  }

  await walk(targetRoot);
  sessions.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return { root: sessionsRoot, target: relative(sessionsRoot, targetRoot).replaceAll("\\", "/") || ".", count: sessions.length, limit: maxItems, sessions };
}

export async function completeCodexSessionInventoryTask(store, config, github, task, context) {
  const boundedLimit = extractTaskLimit(task.description, 50);
  const sessions = await listCodexSessionsMetadata(config, { limit: boundedLimit }, context);
  const now = new Date().toISOString();
  const result = await updateTask(store, task.id, (item) => {
    item.status = "completed";
    item.result = {
      kind: "codex_session_inventory",
      summary: `Listed ${sessions.count} Codex session metadata entries without reading session contents.`,
      sessions,
      completed_at: now
    };
    item.logs.push({ time: now, message: `Safe Codex worker completed session metadata inventory: ${sessions.count} files.` });
  });
  github.syncTask(result.task).catch(() => {});
  return result;
}

export function createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask }) {
  async function createCodexSessionInventoryTask(store, config, { limit = 50 } = {}, context = defaultTokenContext("system")) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const result = await createTask(store, config, {
      title: "List Codex session metadata",
      description: [
        "List Codex session file metadata under /home/a9017/.codex/sessions only.",
        `Return at most ${boundedLimit} files with relative_path, size, and modified_at.`,
        "Do not read session file contents.",
        "Do not inspect tokens, configs, cookies, cache files, memories, or shell snapshots."
      ].join("\n"),
      assignee: "codex",
      mode: "full"
    }, context);
    result.task.status = "assigned";
    result.task.updated_at = new Date().toISOString();
    const state = await store.load();
    state.activities.push({ time: result.task.updated_at, type: "task.assigned_codex", task_id: result.task.id, title: result.task.title });
    await store.save();
    return result;
  }

  return {
    list_codex_sessions_metadata: tool(
      "Use this when the user asks to list /home/a9017 Codex sessions. Lists only files under the approved .codex/sessions directory. Metadata only: relative path, size, and modified time. Does not read session contents.",
      schema({ year: "string", month: "string", day: "string", limit: "integer" }),
      async (args, context) => listCodexSessionsMetadata(config, args, context),
    ),
    create_codex_session_inventory_task: tool(
      "Use this instead of create_task plus assign_task_to_codex when the user asks Codex to list Codex sessions. Creates a safe readonly task, streams progress, immediately runs the approved built-in handler, and returns the completed task with metadata-only results. It explicitly forbids transcript contents, tokens, configs, cookies, cache files, memories, or shell snapshots.",
      schema({ limit: "integer" }),
      async (args, context) => {
        const result = await createCodexSessionInventoryTask(store, config, args, context);
        github.syncTask(result.task).catch(() => {});
        emitTaskProgress(context, result.task, "started", "Safe Codex session metadata inventory started.");
        const completed = await completeCodexSessionInventoryTask(store, config, github, result.task, context);
        emitTaskProgress(context, completed.task, "completed", completed.task.result?.summary || "Safe Codex session metadata inventory completed.");
        return completed;
      },
    ),
  };
}
