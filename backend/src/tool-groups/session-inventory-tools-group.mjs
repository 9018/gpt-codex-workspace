import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { resolveCodexSessionsRoot } from '../codex-session/codex-session-root.mjs';
import { startCodexTuiGoalSession, getCodexTuiSessionStatus, sendCodexTuiSessionInput, sendCodexTuiSlashCommand, stopCodexTuiSession } from '../codex-tui-session-manager.mjs';
import { activeSessions } from '../codex-tui/active-session-registry.mjs';
import { requireScope, defaultTokenContext } from '../auth-context.mjs';
import { extractTaskLimit } from '../task-status.mjs';
import { emitTaskProgress, updateTask } from '../task-lifecycle.mjs';


function resolveSessionsRoot(config) {
  return resolveCodexSessionsRoot(config.codexHome);
}

function safeSessionPath(config, relativePath) {
  const root = resolve(resolveSessionsRoot(config));
  const target = resolve(root, String(relativePath || ""));
  if (target !== root && !target.startsWith(root + sep)) throw new Error("session path escapes sessions root");
  if (!target.endsWith(".jsonl")) throw new Error("session path must reference a .jsonl file");
  return { root, target };
}

function nativeSessionIdFromPath(path) {
  const match = String(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!match) throw new Error("native session id not found in path");
  return match[1];
}

export async function readCodexNativeSession(config, { relative_path, cursor = 0, max_bytes = 262144 }, context) {
  requireScope(context, "workspace:read");
  const { root, target } = safeSessionPath(config, relative_path);
  const buf = await readFile(target);
  const start = Math.max(0, Math.min(Number(cursor) || 0, buf.length));
  const requestedEnd = Math.min(buf.length, start + Math.max(1024, Math.min(Number(max_bytes) || 262144, 1048576)));
  let end = requestedEnd;
  if (requestedEnd < buf.length) {
    const lastNewline = buf.lastIndexOf(0x0a, requestedEnd - 1);
    end = lastNewline >= start ? lastNewline + 1 : start;
  }
  const chunk = buf.subarray(start, end).toString("utf8");
  const messages = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const payload = value.payload || value;
      const role = payload.role || value.role || payload.type || value.type || "event";
      const content = payload.content ?? payload.message ?? payload.text ?? null;
      messages.push({ role, content, timestamp: value.timestamp || payload.timestamp || null, raw_type: value.type || null });
    } catch {
      messages.push({ role: "raw", content: line, timestamp: null, raw_type: "unparsed" });
    }
  }
  return { native_session_id: nativeSessionIdFromPath(target), relative_path: relative(root, target).replaceAll("\\", "/"), cursor: start, next_cursor: end, eof: end >= buf.length, messages };
}


function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item === 'string' ? item : (item?.text || item?.content || '')).filter(Boolean).join('\n');
}

function normalizedPreview(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function objectiveFromInternalContext(text) {
  const match = String(text || '').match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  return match ? normalizedPreview(match[1], 160) : '';
}

function isIgnoredUserText(text) {
  const value = String(text || '').trim();
  return !value || value.startsWith('<environment_context>') || value.startsWith('<codex_internal_context') || value.includes('__gptwork_test_invalid_arg__');
}

function activeNativeIdsFromRegistry() {
  const ids = new Set();
  for (const key of activeSessions.keys()) {
    const match = String(key).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) ids.add(match[1].toLowerCase());
  }
  return ids;
}

export async function summarizeCodexNativeSession({ absolutePath, relativePath, stat: fileStat, activeNativeSessionIds = new Set() }) {
  const sessionId = nativeSessionIdFromPath(absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  let cwd = null;
  let title = '';
  let lastAssistantMessage = '';
  let messageCount = 0;
  let terminal = false;
  let parsedLines = 0;
  let isTestSession = false;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    parsedLines += 1;
    const payload = value?.payload || value || {};
    if (!cwd) cwd = payload.cwd || payload.session_meta?.cwd || value.cwd || null;
    const role = payload.role || value.role;
    const text = textFromContent(payload.content ?? payload.message ?? payload.text ?? value.content);
    if (role === 'user' || role === 'assistant') messageCount += 1;
    if (role === 'user') {
      if (text.includes('__gptwork_test_invalid_arg__')) isTestSession = true;
      const objective = objectiveFromInternalContext(text);
      if (!title && objective) title = objective;
      if (!title && !isIgnoredUserText(text)) title = normalizedPreview(text, 160);
    }
    if (role === 'assistant' && text.trim()) lastAssistantMessage = normalizedPreview(text, 500);
    const eventType = String(payload.type || value.type || '').toLowerCase();
    if (/(task_complete|task_completed|turn_complete|turn_completed|session_complete|session_completed|completed|terminated|cancelled|failed)/.test(eventType)) terminal = true;
  }
  if (parsedLines === 0) throw new Error('session contains no valid JSONL records');
  const active = activeNativeSessionIds.has(sessionId.toLowerCase());
  return {
    session_id: sessionId,
    title: title || '(untitled Codex session)',
    updated_at: fileStat.mtime.toISOString(),
    cwd,
    message_count: messageCount,
    last_assistant_message: lastAssistantMessage || null,
    status: active ? 'running' : terminal ? 'finished' : 'idle',
    attachable: !active,
    relative_path: String(relativePath).replaceAll('\\', '/'),
    size_bytes: fileStat.size,
    is_test_session: isTestSession,
  };
}

export async function listCodexNativeSessions(config, { limit = 50, includeTestSessions = false } = {}, context) {
  requireScope(context, 'workspace:read');
  const root = resolveSessionsRoot(config);
  const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ absolutePath: child, stat: await stat(child) });
    }
  }
  await walk(root);
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const sessions = [];
  const errors = [];
  let filteredTestSessions = 0;
  const activeNativeSessionIds = activeNativeIdsFromRegistry();
  for (const file of files) {
    if (sessions.length >= maxItems) break;
    try {
      const relativePath = relative(root, file.absolutePath).replaceAll('\\', '/');
      const summary = await summarizeCodexNativeSession({ ...file, relativePath, activeNativeSessionIds });
      if (summary.is_test_session && !includeTestSessions) { filteredTestSessions += 1; continue; }
      sessions.push(summary);
    } catch (error) {
      errors.push({ relative_path: relative(root, file.absolutePath).replaceAll('\\', '/'), error: error.message });
    }
  }
  return { sessions, count: sessions.length, limit: maxItems, filtered_test_sessions: filteredTestSessions, errors };
}

function validateDateSegment(value) {
  const text = String(value || "").trim();
  if (!/^\d{2,4}$/.test(text)) throw new Error("invalid date segment");
  return text;
}

export async function listCodexSessionsMetadata(config, { year = "", month = "", day = "", limit = 50 }, context) {
  requireScope(context, "workspace:read");
  const sessionsRoot = resolveSessionsRoot(config);
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

    entries.sort((a, b) => b.name.localeCompare(a.name));
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

export function createSessionInventoryToolsGroup({ tool, schema, config, store, github, createTask, sessionApi = {} }) {
  const startSession = sessionApi.start || startCodexTuiGoalSession;
  const statusSession = sessionApi.status || getCodexTuiSessionStatus;
  const sendSession = sessionApi.send || sendCodexTuiSessionInput;
  const sendSlashCommand = sessionApi.sendSlashCommand || (sessionApi.send
    ? (id, command, options) => sessionApi.send(id, `${command}\r`, options)
    : sendCodexTuiSlashCommand);
  const stopSession = sessionApi.stop || stopCodexTuiSession;

  async function audit(action, details = {}) {
    const entry = { time: new Date().toISOString(), type: `codex.native_session.${action}`, ...details };
    if (typeof store?.mutate === 'function') {
      await store.mutate((state) => { state.activities ||= []; state.activities.push(entry); });
      return;
    }
    if (typeof store?.load === 'function' && typeof store?.save === 'function') {
      const state = await store.load(); state.activities ||= []; state.activities.push(entry); await store.save();
    }
  }
  async function createCodexSessionInventoryTask(store, config, { limit = 50 } = {}, context = defaultTokenContext("system")) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const result = await createTask(store, config, {
      title: "List Codex session metadata",
      description: [
        "List Codex session file metadata under the configured CODEX_HOME/sessions directory only.",
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
      "Use this when the user asks to list Codex sessions. Lists only files under the configured CODEX_HOME/sessions directory. Metadata only: relative path, size, and modified time. Does not read session contents.",
      schema({ year: "string", month: "string", day: "string", limit: "integer" }),
      async (args, context) => listCodexSessionsMetadata(config, args, context),
    ),
    codex_native_sessions_list: tool(
      "List native Codex sessions with Resume-style title, cwd, message count, last assistant reply, lifecycle status, and attach compatibility.",
      schema({ limit: "integer", include_test_sessions: "boolean" }),
      async ({ limit, include_test_sessions = false }, context) => listCodexNativeSessions(config, { limit, includeTestSessions: include_test_sessions }, context),
    ),
    codex_native_session_read: tool(
      "Read structured messages from any native Codex session JSONL under the configured sessions root.",
      schema({ relative_path: "string", cursor: "integer", max_bytes: "integer" }, ["relative_path"]),
      async (args, context) => { const result = await readCodexNativeSession(config, args, context); await audit('read', { native_session_id: result.native_session_id, relative_path: result.relative_path }); return result; },
    ),
    codex_native_session_attach: tool(
      "Resume a native Codex session through Codex CLI and return a controllable TUI session id.",
      schema({ relative_path: "string", cwd: "string" }, ["relative_path"]),
      async ({ relative_path, cwd }, context) => {
        requireScope(context, "workspace:write");
        const { target } = safeSessionPath(config, relative_path);
        const nativeSessionId = nativeSessionIdFromPath(target);
        const session = await startSession({
          task: { id: `native_${nativeSessionId}` },
          goal: { id: `native_${nativeSessionId}` },
          cwd: cwd || config.workspaceRoot,
          workspaceRoot: config.workspaceRoot,
          candidateWorkspaceRoots: [config.workspaceRoot],
          resumeNativeSessionId: nativeSessionId,
          requireSuperpowers: false,
        });
        const result = { native_session_id: nativeSessionId, control_session_id: session.id, status: session.status };
        await audit('attach', result);
        return result;
      },
    ),
    codex_native_session_status: tool(
      "Read status of an attached native Codex session control channel.",
      schema({ control_session_id: "string" }, ["control_session_id"]),
      async ({ control_session_id }, context) => { requireScope(context, "workspace:read"); return statusSession(control_session_id, { workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] }); },
    ),
    codex_native_session_send: tool(
      "Send an instruction to an attached native Codex session.",
      schema({ control_session_id: "string", text: "string" }, ["control_session_id", "text"]),
      async ({ control_session_id, text }, context) => { requireScope(context, "workspace:write"); const result = await sendSession(control_session_id, text, { workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] }); await audit('send', { control_session_id }); return result; },
    ),
    codex_native_session_detach: tool(
      "Detach the control channel for a native Codex session without changing its Goal lifecycle.",
      schema({ control_session_id: "string" }, ["control_session_id"]),
      async ({ control_session_id }, context) => { requireScope(context, "workspace:write"); const result = await stopSession(control_session_id, { reason: "native_detach", workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] }); await audit('detach', { control_session_id }); return result; },
    ),
    codex_native_goal_pause: tool(
      "Pause the persistent Goal in an attached native Codex session. The control channel remains attached.",
      schema({ control_session_id: "string" }, ["control_session_id"]),
      async ({ control_session_id }, context) => { requireScope(context, "workspace:write"); const result = await sendSlashCommand(control_session_id, "/goal pause", { workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] }); await audit('goal_pause', { control_session_id }); return { ...result, goal_command: "/goal pause", goal_action: "pause_requested" }; },
    ),
    codex_native_goal_clear: tool(
      "Clear the persistent Goal in an attached native Codex session. The control channel remains attached for confirmation or later detach.",
      schema({ control_session_id: "string" }, ["control_session_id"]),
      async ({ control_session_id }, context) => { requireScope(context, "workspace:write"); const result = await sendSlashCommand(control_session_id, "/goal clear", { workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] }); await audit('goal_clear', { control_session_id }); return { ...result, goal_command: "/goal clear", goal_action: "clear_requested" }; },
    ),
    codex_native_goal_stop: tool(
      "Stop the persistent Goal by sending /goal clear before detaching the control channel.",
      schema({ control_session_id: "string" }, ["control_session_id"]),
      async ({ control_session_id }, context) => {
        requireScope(context, "workspace:write");
        await sendSlashCommand(control_session_id, "/goal clear", { workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] });
        const result = await stopSession(control_session_id, { reason: "native_detach", workspaceRoot: config.workspaceRoot, candidateWorkspaceRoots: [config.workspaceRoot] });
        await audit('goal_stop', { control_session_id });
        return { ...result, goal_command: "/goal clear", goal_action: "clear_requested_then_detached" };
      },
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
