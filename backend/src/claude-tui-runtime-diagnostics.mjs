/**
 * claude-tui-runtime-diagnostics.mjs — Runtime diagnostics for Claude TUI provider.
 *
 * Mirrors codex-tui-runtime-diagnostics.mjs but for the claude_tui_goal provider.
 * Scans the shared session store, evaluates completion evidence, and produces
 * the same diagnostic shape with Claude-specific labels.
 */

import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { isClaudeTuiEnabled, AGENT_TUI_PROVIDERS, CODEX_EXECUTION_PROVIDERS } from "./codex-execution-provider.mjs";
import { CODEX_TUI_SESSIONS_DIR, assertSafeCodexTuiSessionId } from "./codex-tui-session-store.mjs";
import { collectCodexTuiCompletion } from "./codex-tui-completion-collector.mjs";

const DEFAULT_MAX_SESSIONS = 20;
const ACTIVE_SESSION_STATUSES = new Set(["created", "starting", "running"]);

async function pathExists(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadTasks(store) {
  const stateTasks = store?.state?.tasks;
  if (Array.isArray(stateTasks)) return stateTasks;
  if (typeof store?.load === "function") {
    try {
      const state = await store.load();
      if (Array.isArray(state?.tasks)) return state.tasks;
    } catch {
      return [];
    }
  }
  return [];
}

function severityRank(severity) {
  switch (severity) {
    case "error": return 4;
    case "warning": return 3;
    case "info": return 2;
    default: return 1;
  }
}

function addFinding(findings, finding) {
  if (!finding?.code) return;
  const existing = findings.find(
    (item) => item.code === finding.code && item.session_id === finding.session_id && item.task_id === finding.task_id
  );
  if (existing) return;
  findings.push(finding);
}

async function scanSessionRecords(sessionsDir) {
  const result = {
    present: existsSync(sessionsDir),
    readable: true,
    invalid_record_count: 0,
    records: [],
  };
  if (!result.present) return result;

  let entries = [];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    result.readable = false;
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    try {
      assertSafeCodexTuiSessionId(id);
      const text = await readFile(join(sessionsDir, entry.name), "utf8");
      const record = JSON.parse(text);
      result.records.push({
        id,
        task_id: record?.task_id || null,
        goal_id: record?.goal_id || null,
        cwd: record?.cwd || null,
        repo_lock_id: record?.repo_lock_id || null,
        status: record?.status || "unknown",
        metadata: record?.metadata || {},
        created_at: record?.created_at || null,
        updated_at: record?.updated_at || null,
        pty_pid: record?.pty_pid ?? null,
      });
    } catch {
      result.invalid_record_count += 1;
    }
  }

  result.records.sort(
    (a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
      String(a.id).localeCompare(String(b.id))
  );
  return result;
}

function safeCollectorFindings(findings = [], sessionId) {
  return findings.map((finding) => ({
    code: `claude_tui_${finding.code}`,
    severity: finding.code === "dirty_worktree" ? "warning" : "info",
    category: "provider_result_contract",
    session_id: sessionId,
    message:
      finding.code === "dirty_worktree"
        ? "Claude TUI completion snapshot reports dirty worktree state."
        : "Claude TUI completion snapshot is missing durable result contract evidence.",
  }));
}

/**
 * Collect Claude TUI runtime diagnostics.
 * Returns the same shape as codex-tui-runtime-diagnostics but with
 * Claude-specific provider labels.
 */
export async function collectClaudeTuiRuntimeDiagnostics({
  workspaceRoot,
  store,
  config = {},
  env = process.env,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  if (!workspaceRoot) return null;

  const sessionsDir = join(workspaceRoot, CODEX_TUI_SESSIONS_DIR);
  const sessionScan = await scanSessionRecords(sessionsDir);
  const tasks = await loadTasks(store);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const enabled = isClaudeTuiEnabled(config, env);
  const relevant = enabled || sessionScan.records.length > 0 || sessionScan.invalid_record_count > 0 || !sessionScan.readable;
  if (!relevant) return null;

  const findings = [];

  if (!sessionScan.readable) {
    addFinding(findings, {
      code: "claude_tui_session_store_unreadable",
      severity: "warning",
      category: "session_store",
      message: "Claude TUI session store exists but cannot be read.",
    });
  }
  if (sessionScan.invalid_record_count > 0) {
    addFinding(findings, {
      code: "claude_tui_session_store_invalid_records",
      severity: "warning",
      category: "session_store",
      message: "Claude TUI session store contains malformed session metadata records.",
    });
  }

  let readyForReviewCount = 0;
  let noResultCount = 0;
  let sessionSummaries = [];

  // Only include sessions that appear to be from the claude provider
  // (all sessions share the same store, so filter by metadata.provider)
  const claudeRecords = sessionScan.records.filter(
    (r) => r.metadata?.provider === "claude" || !r.metadata?.provider
  );

  for (const record of claudeRecords.slice(0, Number(maxSessions) || DEFAULT_MAX_SESSIONS)) {
    const task = record.task_id ? taskById.get(record.task_id) : null;
    const cwdExists = await pathExists(record.cwd);
    const resultJsonPath = record.goal_id
      ? join(workspaceRoot, ".gptwork", "goals", record.goal_id, "result.json")
      : null;
    const resultJsonPresent = await pathExists(resultJsonPath);
    const hasLog = await pathExists(join(sessionsDir, `${record.id}.log`));

    let completion = null;
    try {
      completion = await collectCodexTuiCompletion({ sessionId: record.id, workspaceRoot });
    } catch (err) {
      addFinding(findings, {
        code: "claude_tui_completion_collect_failed",
        severity: "warning",
        category: "completion_collector",
        session_id: record.id,
        message: `Claude TUI completion collector could not summarize session state: ${String(err?.message || err).slice(0, 160)}`,
      });
    }

    const resultMdPresent = completion?.result_md_present === true;
    const commit = completion?.commit || null;
    const testsPresent = Boolean(completion?.tests);
    const worktreeClean = completion?.worktree_clean ?? null;
    const readyForReview = completion?.ready_for_review === true;
    const noResult = !resultMdPresent && !resultJsonPresent;

    if (readyForReview) readyForReviewCount += 1;
    if (noResult) noResultCount += 1;

    if (noResult) {
      addFinding(findings, {
        code: "claude_tui_no_result",
        severity: "info",
        category: "provider_result_contract",
        session_id: record.id,
        task_id: record.task_id,
        message: "Claude TUI session has no result.md or result.json evidence yet.",
      });
    }
    if (record.cwd && !cwdExists) {
      addFinding(findings, {
        code: "claude_tui_session_cwd_missing",
        severity: "warning",
        category: "retained_reference",
        session_id: record.id,
        task_id: record.task_id,
        message: "Claude TUI session references a worktree path that is no longer present.",
      });
    }
    for (const finding of safeCollectorFindings(completion?.findings || [], record.id)) {
      addFinding(findings, finding);
    }

    sessionSummaries.push({
      id: record.id,
      task_id: record.task_id,
      goal_id: record.goal_id,
      status: record.status,
      active: ACTIVE_SESSION_STATUSES.has(record.status),
      cwd_present: Boolean(record.cwd),
      cwd_exists: record.cwd ? cwdExists : null,
      has_log: hasLog,
      result_md_present: resultMdPresent,
      result_json_present: resultJsonPresent,
      worktree_clean: worktreeClean,
      commit,
      tests_present: testsPresent,
      ready_for_review: readyForReview,
      updated_at: record.updated_at,
      created_at: record.created_at,
      pty_pid: record.pty_pid,
    });
  }

  const activeCount = sessionSummaries.filter((session) => session.active).length;
  const highestSeverity = findings.reduce(
    (current, finding) => (severityRank(finding.severity) > severityRank(current) ? finding.severity : current),
    "ok"
  );

  return {
    provider: AGENT_TUI_PROVIDERS.CLAUDE,
    provider_label: "claude_tui_goal (optional, explicit provider, Claude Code)",
    optional: true,
    activation: "explicit_only",
    default_provider: CODEX_EXECUTION_PROVIDERS.EXEC,
    enabled,
    config_source: "default",
    explicit_task_count: 0,
    explicit_task_ids: [],
    session_store: {
      present: sessionScan.present,
      readable: sessionScan.readable,
      session_count: claudeRecords.length,
      active_count: activeCount,
      running_count: sessionSummaries.filter((session) => session.status === "running").length,
      invalid_record_count: sessionScan.invalid_record_count,
    },
    completion: {
      ready_for_review_count: readyForReviewCount,
      no_result_count: noResultCount,
    },
    finding_count: findings.length,
    highest_severity: highestSeverity,
    findings,
    sessions: sessionSummaries,
  };
}
