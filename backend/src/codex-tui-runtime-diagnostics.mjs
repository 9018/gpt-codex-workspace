import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { CODEX_EXECUTION_PROVIDERS, isCodexTuiEnabled, taskUsesCodexTuiGoal } from "./codex-execution-provider.mjs";
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

function codexTuiConfigSource(config = {}, env = process.env) {
  if (config.codexTuiEnabled !== undefined || config.codex_tui_enabled !== undefined) return "config";
  if (env.GPTWORK_CODEX_TUI_ENABLED !== undefined) return "process.env";
  return "default";
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
  const existing = findings.find((item) => item.code === finding.code && item.session_id === finding.session_id && item.task_id === finding.task_id);
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
        created_at: record?.created_at || null,
        updated_at: record?.updated_at || null,
        pty_pid: record?.pty_pid ?? null,
      });
    } catch {
      result.invalid_record_count += 1;
    }
  }

  result.records.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) || String(a.id).localeCompare(String(b.id)));
  return result;
}

function safeCollectorFindings(findings = [], sessionId, { active = false } = {}) {
  return findings.map((finding) => ({
    code: `codex_tui_${finding.code}`,
    severity: finding.code === "dirty_worktree" && active ? "warning" : "info",
    category: active ? "provider_result_contract" : "historical_result_contract",
    ...(active ? {} : { historical: true }),
    session_id: sessionId,
    message: finding.code === "dirty_worktree"
      ? "TUI completion snapshot reports dirty worktree state. Treat this as provider/result contract evidence, not a real-code blocker by itself."
      : "TUI completion snapshot is missing durable result contract evidence.",
  }));
}

export async function collectCodexTuiRuntimeDiagnostics({
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
  const explicitTasks = tasks.filter((task) => taskUsesCodexTuiGoal(task));
  const enabled = isCodexTuiEnabled(config, env);
  const relevant = enabled || explicitTasks.length > 0 || sessionScan.records.length > 0 || sessionScan.invalid_record_count > 0 || !sessionScan.readable;
  if (!relevant) return null;

  const findings = [];
  if (!enabled && explicitTasks.length > 0) {
    addFinding(findings, {
      code: "codex_tui_goal_disabled",
      severity: "warning",
      category: "provider_configuration",
      message: "codex_tui_goal is explicitly selected by task metadata but disabled by runtime configuration.",
    });
  }
  if (!sessionScan.readable) {
    addFinding(findings, {
      code: "codex_tui_session_store_unreadable",
      severity: "warning",
      category: "session_store",
      message: "TUI session store exists but cannot be read.",
    });
  }
  if (sessionScan.invalid_record_count > 0) {
    addFinding(findings, {
      code: "codex_tui_session_store_invalid_records",
      severity: "warning",
      category: "session_store",
      message: "TUI session store contains malformed session metadata records.",
    });
  }

  let readyForReviewCount = 0;
  let noResultCount = 0;
  let resultMissingCount = 0;
  let resultJsonMissingCount = 0;
  let commitMissingCount = 0;
  let dirtyWorktreeCount = 0;
  let testsMissingCount = 0;
  let staleReferenceCount = 0;
  let retainedReferenceCount = 0;
  const sessionSummaries = [];

  for (const record of sessionScan.records.slice(0, Number(maxSessions) || DEFAULT_MAX_SESSIONS)) {
    const task = record.task_id ? taskById.get(record.task_id) : null;
    const taskExplicit = task ? taskUsesCodexTuiGoal(task) : false;
    const activeSession = ACTIVE_SESSION_STATUSES.has(record.status);
    const referenceSeverity = activeSession ? "warning" : "info";
    const cwdExists = await pathExists(record.cwd);
    const resultJsonPath = record.goal_id ? join(workspaceRoot, ".gptwork", "goals", record.goal_id, "result.json") : null;
    const resultJsonPresent = await pathExists(resultJsonPath);
    const hasLog = await pathExists(join(sessionsDir, `${record.id}.log`));

    let completion = null;
    try {
      completion = await collectCodexTuiCompletion({ sessionId: record.id, workspaceRoot });
    } catch (err) {
      addFinding(findings, {
        code: "codex_tui_completion_collect_failed",
        severity: "warning",
        category: "completion_collector",
        session_id: record.id,
        message: `TUI completion collector could not summarize session state: ${String(err?.message || err).slice(0, 160)}`,
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
    if (!resultMdPresent) resultMissingCount += 1;
    if (!resultJsonPresent) resultJsonMissingCount += 1;
    if (!commit && worktreeClean === false) commitMissingCount += 1;
    if (worktreeClean === false) dirtyWorktreeCount += 1;
    if (!testsPresent) testsMissingCount += 1;
    if (record.repo_lock_id || record.status || record.task_id || record.goal_id) retainedReferenceCount += 1;
    if (record.cwd && !cwdExists) staleReferenceCount += 1;

    if (noResult) {
      addFinding(findings, {
        code: "codex_tui_no_result",
        severity: "info",
        category: "provider_result_contract",
        session_id: record.id,
        task_id: record.task_id,
        message: "TUI session has no result.md or result.json evidence yet.",
      });
    }
    if (resultMdPresent && !resultJsonPresent) {
      addFinding(findings, {
        code: "codex_tui_result_json_missing",
        severity: "info",
        category: "provider_result_contract",
        session_id: record.id,
        task_id: record.task_id,
        message: "TUI result.md exists but result.json is missing; this is provider/result contract evidence.",
      });
    }
    if (record.cwd && !cwdExists) {
      addFinding(findings, {
        code: "codex_tui_session_cwd_missing",
        severity: referenceSeverity,
        category: activeSession ? "retained_reference" : "historical_reference",
        historical: !activeSession,
        session_id: record.id,
        task_id: record.task_id,
        message: activeSession
          ? "TUI session references a worktree path that is no longer present."
          : "Stopped historical TUI session references a worktree path that is no longer present.",
      });
    }
    if (record.task_id && task && !taskExplicit) {
      addFinding(findings, {
        code: "codex_tui_provider_metadata_missing",
        severity: referenceSeverity,
        category: activeSession ? "provider_metadata" : "historical_reference",
        historical: !activeSession,
        session_id: record.id,
        task_id: record.task_id,
        message: activeSession
          ? "TUI session references a task whose metadata no longer explicitly selects codex_tui_goal."
          : "Stopped historical TUI session references a task whose current metadata no longer selects codex_tui_goal.",
      });
    }
    if (record.task_id && !task) {
      addFinding(findings, {
        code: "codex_tui_task_missing",
        severity: referenceSeverity,
        category: activeSession ? "retained_reference" : "historical_reference",
        historical: !activeSession,
        session_id: record.id,
        task_id: record.task_id,
        message: activeSession
          ? "TUI session references a task that is not present in state."
          : "Stopped historical TUI session references a task that is no longer retained in current state.",
      });
    }
    for (const finding of safeCollectorFindings(completion?.findings || [], record.id, { active: activeSession })) addFinding(findings, finding);

    sessionSummaries.push({
      id: record.id,
      task_id: record.task_id,
      goal_id: record.goal_id,
      status: record.status,
      active: activeSession,
      task_metadata_explicit: taskExplicit,
      task_present: record.task_id ? Boolean(task) : null,
      cwd_present: Boolean(record.cwd),
      cwd_exists: record.cwd ? cwdExists : null,
      repo_lock_id: record.repo_lock_id || null,
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
  const highestSeverity = findings.reduce((current, finding) => severityRank(finding.severity) > severityRank(current) ? finding.severity : current, "ok");

  return {
    provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    provider_label: "codex_tui_goal (optional, explicit provider)",
    optional: true,
    activation: "explicit_only",
    default_provider: CODEX_EXECUTION_PROVIDERS.EXEC,
    enabled,
    config_source: codexTuiConfigSource(config, env),
    explicit_task_count: explicitTasks.length,
    explicit_task_ids: explicitTasks.map((task) => task.id).sort(),
    session_store: {
      present: sessionScan.present,
      readable: sessionScan.readable,
      session_count: sessionScan.records.length,
      active_count: activeCount,
      running_count: sessionSummaries.filter((session) => session.status === "running").length,
      invalid_record_count: sessionScan.invalid_record_count,
      retained_reference_count: retainedReferenceCount,
      stale_reference_count: staleReferenceCount,
    },
    completion: {
      ready_for_review_count: readyForReviewCount,
      no_result_count: noResultCount,
      result_missing_count: resultMissingCount,
      result_json_missing_count: resultJsonMissingCount,
      commit_missing_count: commitMissingCount,
      dirty_worktree_count: dirtyWorktreeCount,
      tests_missing_count: testsMissingCount,
    },
    finding_count: findings.length,
    highest_severity: highestSeverity,
    findings,
    sessions: sessionSummaries,
  };
}
