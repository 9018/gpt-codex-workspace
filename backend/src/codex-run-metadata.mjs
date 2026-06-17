/**
 * codex-run-metadata.mjs — Run metadata, heartbeat, diagnostics, and recovery for Codex tasks.
 *
 * Provides:
 * - Per-run metadata stored under .gptwork/runs/<task_id>/<run_id>/run.json
 * - Heartbeat updates during Codex execution phases
 * - Durable stdout/stderr log files for each run
 * - Task diagnostics to identify stalled/stuck Codex runs
 * - Recovery actions for stuck tasks (mark_waiting_review, mark_failed, reset_to_assigned, etc.)
 * - Startup reconciliation for tasks left in "running" state after service restart
 * - Secret stripping to keep passwords/tokens out of diagnostic output
 */

import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const RUNS_DIR = ".gptwork/runs";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getRunsBaseDir(workspaceRoot) {
  return join(workspaceRoot, RUNS_DIR);
}

export function getRunDir(workspaceRoot, taskId, runId) {
  return join(getRunsBaseDir(workspaceRoot), String(taskId), String(runId));
}

export function getRunFilePath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "run.json");
}

export function getStdoutLogPath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "stdout.log");
}

export function getStderrLogPath(workspaceRoot, taskId, runId) {
  return join(getRunDir(workspaceRoot, taskId, runId), "stderr.log");
}

// ---------------------------------------------------------------------------
// Run metadata lifecycle
// ---------------------------------------------------------------------------

/**
 * Create initial run metadata for a Codex execution.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot — workspace root path
 * @param {string} opts.taskId — task id
 * @param {string} [opts.workspaceId] — workspace id
 * @param {string} [opts.repoPath] — canonical repo path if known
 * @param {string} [opts.promptPath] — prompt file path if written
 * @returns {Promise<{runDir: string, runFilePath: string, runId: string, runData: object}>}
 */
export async function initRun(opts = {}) {
  const { workspaceRoot, taskId, workspaceId, repoPath, promptPath } = opts;
  if (!workspaceRoot || !taskId) {
    throw new Error("workspaceRoot and taskId are required for initRun");
  }

  const runId = randomUUID();
  const runDir = getRunDir(workspaceRoot, taskId, runId);
  await mkdir(runDir, { recursive: true });

  const now = new Date().toISOString();
  const runData = {
    run_id: runId,
    task_id: taskId,
    started_at: now,
    last_heartbeat_at: now,
    phase: "preparing",
    codex_child_pid: null,
    workspace_id: workspaceId || null,
    repo_path: repoPath || null,
    prompt_path: promptPath || null,
    stdout_log_path: getStdoutLogPath(workspaceRoot, taskId, runId),
    stderr_log_path: getStderrLogPath(workspaceRoot, taskId, runId),
    result_json_path: null,
    exit_code: null,
    timed_out: false
  };

  const runFilePath = getRunFilePath(workspaceRoot, taskId, runId);
  await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");

  return { runDir, runFilePath, runId, runData };
}

/**
 * Update heartbeat and optional fields in run.json.
 *
 * @param {string} runFilePath — path to run.json
 * @param {string} phase — current phase name
 * @param {object} [fields] — additional fields to merge (e.g. codex_child_pid, exit_code)
 * @returns {Promise<object>} updated run data
 */
export async function updateRunHeartbeat(runFilePath, phase, fields = {}) {
  let runData;
  try {
    runData = JSON.parse(await readFile(runFilePath, "utf8"));
  } catch {
    // If run.json can't be read, start fresh with basic data
    runData = { run_id: "unknown", phase: "unknown" };
  }

  runData.last_heartbeat_at = new Date().toISOString();
  runData.phase = phase;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      runData[key] = value;
    }
  }

  await writeFile(runFilePath, JSON.stringify(runData, null, 2) + "\n", "utf8");
  return runData;
}

/**
 * Fire-and-forget heartbeat update. Non-blocking; errors are silently caught.
 */
export function fireHeartbeat(runFilePath, phase, fields = {}) {
  if (!runFilePath) return;
  updateRunHeartbeat(runFilePath, phase, fields).catch(() => {});
}

/**
 * Write stdout and stderr to durable log files for a run.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string} opts.taskId
 * @param {string} opts.runId
 * @param {string} [opts.stdout]
 * @param {string} [opts.stderr]
 */
export async function writeRunLogs(opts = {}) {
  const { workspaceRoot, taskId, runId, stdout, stderr } = opts;
  if (!workspaceRoot || !taskId || !runId) return;

  const stdLog = getStdoutLogPath(workspaceRoot, taskId, runId);
  const errLog = getStderrLogPath(workspaceRoot, taskId, runId);

  if (stdout) {
    await mkdir(dirname(stdLog), { recursive: true });
    await writeFile(stdLog, stdout, "utf8");
  }
  if (stderr) {
    await mkdir(dirname(errLog), { recursive: true });
    await writeFile(errLog, stderr, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Run queries
// ---------------------------------------------------------------------------

/**
 * Load run metadata for a specific run.
 * Returns null if the run file does not exist or is invalid.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
export async function loadRun(workspaceRoot, taskId, runId) {
  try {
    const data = JSON.parse(await readFile(getRunFilePath(workspaceRoot, taskId, runId), "utf8"));
    return data;
  } catch {
    return null;
  }
}

/**
 * List all runs for a task, newest first.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object[]>}
 */
export async function listRuns(workspaceRoot, taskId) {
  const baseDir = join(getRunsBaseDir(workspaceRoot), String(taskId));
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runData = await loadRun(workspaceRoot, taskId, entry.name);
        if (runData) runs.push(runData);
      }
    }
    runs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    return runs;
  } catch {
    return [];
  }
}

/**
 * Get the latest run for a task (most recent started_at), or null.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function getLatestRun(workspaceRoot, taskId) {
  const runs = await listRuns(workspaceRoot, taskId);
  return runs.length > 0 ? runs[0] : null;
}

// ---------------------------------------------------------------------------
// Process/repo introspection
// ---------------------------------------------------------------------------

/**
 * Check if a process is alive by sending signal 0.
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a git repo has uncommitted changes.
 *
 * @param {string|null|undefined} repoPath
 * @returns {boolean}
 */
export function isRepoDirty(repoPath) {
  if (!repoPath) return false;
  try {
    if (!existsSync(join(repoPath, ".git"))) return false;
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get list of changed file paths from git status (porcelain).
 *
 * @param {string|null|undefined} repoPath
 * @returns {string[]}
 */
export function getChangedFiles(repoPath) {
  if (!repoPath) return [];
  try {
    if (!existsSync(join(repoPath, ".git"))) return [];
    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return status.trim().split("\n").filter(Boolean).map((line) => {
      // porcelain format: XY filename or XY -> renamed filename
      const trimmed = line.trim();
      // Handle renamed/moved files
      if (trimmed.startsWith("R") || trimmed.startsWith("C")) {
        const parts = trimmed.split(/\s+/);
        return parts[parts.length - 1];
      }
      return trimmed.slice(2).trim();
    });
  } catch {
    return [];
  }
}

/**
 * Get the exit code of a process by pid (via /proc).
 * Returns null if the process no longer exists or the info is unavailable.
 *
 * @param {number} pid
 * @returns {number|null}
 */
export function getProcessExitCode(pid) {
  if (!pid || pid <= 0) return null;
  try {
    // On Linux, /proc/<pid>/exited is not directly available,
    // so check if the process is gone
    process.kill(pid, 0);
    return null; // process still alive
  } catch {
    return -1; // process no longer exists
  }
}

// ---------------------------------------------------------------------------
// Stuck task detection
// ---------------------------------------------------------------------------

/**
 * Find all tasks that appear stuck: status is "running" with no active process
 * or stale heartbeat beyond the threshold.
 *
 * @param {object} state — loaded state with tasks array
 * @param {string} workspaceRoot
 * @param {number} [stallThresholdSeconds=600]
 * @returns {Promise<Array<{task: object, run: object|null, diagnostics: object}>>}
 */
export async function findStuckTasks(state, workspaceRoot, stallThresholdSeconds = 600) {
  const stuck = [];
  const now = Date.now();

  for (const task of (state.tasks || [])) {
    if (task.status !== "running") continue;

    const run = await getLatestRun(workspaceRoot, task.id);
    const diagnostics = { task_id: task.id, title: task.title, status: task.status, has_run: !!run };

    if (run) {
      const ageSec = (now - new Date(run.last_heartbeat_at).getTime()) / 1000;
      diagnostics.last_heartbeat_at = run.last_heartbeat_at;
      diagnostics.heartbeat_age_seconds = Math.round(ageSec);
      diagnostics.phase = run.phase;
      diagnostics.codex_child_pid = run.codex_child_pid;
      diagnostics.process_alive = isProcessAlive(run.codex_child_pid);
      diagnostics.stdout_log_path = run.stdout_log_path;
      diagnostics.stderr_log_path = run.stderr_log_path;
      diagnostics.result_json_path = run.result_json_path;

      if (!diagnostics.process_alive && ageSec > stallThresholdSeconds) {
        stuck.push({ task, run, diagnostics });
      }
    } else {
      // Running with no run metadata at all
      stuck.push({ task, run: null, diagnostics });
    }
  }

  return stuck;
}

// ---------------------------------------------------------------------------
// Diagnostic tool
// ---------------------------------------------------------------------------

/**
 * Diagnose a single task. Returns structured diagnostic info including task state,
 * run metadata, process status, repo dirtiness, likely cause, and suggested actions.
 * Secrets are stripped from the output.
 *
 * @param {object} state — loaded state with tasks array
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {number} [stallThresholdSeconds=600]
 * @returns {Promise<object>}
 */
export async function diagnoseTask(state, workspaceRoot, taskId, stallThresholdSeconds = 600) {
  const task = (state.tasks || []).find((t) => t.id === taskId);
  if (!task) return { error: `task not found: ${taskId}` };

  const run = await getLatestRun(workspaceRoot, taskId);
  const now = Date.now();
  const taskAgeSec = (now - new Date(task.created_at).getTime()) / 1000;

  const result = {
    task_id: task.id,
    title: task.title,
    status: task.status,
    mode: task.mode,
    age_seconds: Math.round(taskAgeSec),
    created_at: task.created_at,
    updated_at: task.updated_at,
    log_count: task.logs?.length || 0,
    last_log: task.logs?.length > 0 ? task.logs[task.logs.length - 1] : null,
    has_run: !!run
  };

  if (run) {
    const heartbeatAgeSec = (now - new Date(run.last_heartbeat_at).getTime()) / 1000;
    result.run_id = run.run_id;
    result.run_started_at = run.started_at;
    result.last_heartbeat_at = run.last_heartbeat_at;
    result.heartbeat_age_seconds = Math.round(heartbeatAgeSec);
    result.phase = run.phase;
    result.codex_child_pid = run.codex_child_pid;
    result.process_alive = isProcessAlive(run.codex_child_pid);
    result.stdout_log_path = run.stdout_log_path;
    result.stderr_log_path = run.stderr_log_path;
    result.result_json_path = run.result_json_path;
    result.exit_code = run.exit_code;

    // Check result.json file presence
    let hasResultJson = false;
    if (run.result_json_path) {
      try {
        hasResultJson = existsSync(run.result_json_path);
      } catch {}
    }
    result.has_result_json = hasResultJson;
  }

  // Repo state
  result.repo_dirty = isRepoDirty(workspaceRoot);
  if (result.repo_dirty) {
    result.changed_files = getChangedFiles(workspaceRoot);
  } else {
    result.changed_files = [];
  }

  // Likely cause and suggested actions
  const stallThreshold = stallThresholdSeconds;
  if (task.status === "running" && result.has_run) {
    if (!result.process_alive && result.heartbeat_age_seconds > stallThreshold) {
      result.likely_cause = "Codex process exited or was killed without updating the task. Run metadata shows no active process and no recent heartbeat.";
      const actions = [
        { action: "inspect_only", label: "Re-run diagnostics" },
        { action: "mark_waiting_review", label: "Mark for human review (recommended if repo is dirty)" },
        { action: "mark_failed", label: "Mark as failed (safe if repo is clean)" },
        { action: "reset_to_assigned", label: "Reset to assigned for re-execution" }
      ];
      if (result.has_result_json) {
        actions.push({ action: "finalize_if_result_json", label: "Finalize with existing result.json" });
      }
      result.suggested_actions = actions;
    } else if (result.process_alive) {
      result.likely_cause = "Codex process is still running (PID " + result.codex_child_pid + "). It may be stuck on a long operation or hung I/O.";
      result.suggested_actions = [
        { action: "inspect_only", label: "Check stdout logs for progress" },
        { action: "kill_process_if_alive", label: "Terminate process and investigate" }
      ];
    } else {
      result.likely_cause = "Task is running but has a recent heartbeat. May still be in progress.";
      result.suggested_actions = [{ action: "inspect_only", label: "Wait for the task to complete" }];
    }
  } else if (task.status === "running" && !result.has_run) {
    result.likely_cause = "Task is marked running but has no run metadata. It may have been set running before run tracking was added (legacy).";
    result.suggested_actions = [
      { action: "inspect_only", label: "Inspect further" },
      { action: "mark_failed", label: "Mark as failed" }
    ];
  } else {
    result.likely_cause = "Task is not in running state. No diagnostic needed.";
    result.suggested_actions = [];
  }

  // Strip secrets from the output
  return stripSecrets(result);
}

// ---------------------------------------------------------------------------
// Secret stripping
// ---------------------------------------------------------------------------

const SECRET_FIELD_RE = /^(password|secret|token|credential|key|api_key|api_secret|access_key|private_key)$/i;

/**
 * Recursively strip potential secret values from diagnostic output.
 * String field values whose keys match known secret patterns are redacted.
 * The shape of the object is preserved.
 *
 * @param {*} obj
 * @returns {*}
 */
export function stripSecrets(obj) {
  if (typeof obj === "string") return obj;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(stripSecrets);
  }

  const safe = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELD_RE.test(key) && typeof value === "string") {
      safe[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      safe[key] = stripSecrets(value);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Performs startup reconciliation on tasks in "running" status.
 * Marks them as "waiting_for_review" if no active process exists and heartbeat is stale.
 * Does NOT auto-commit or discard uncommitted changes.
 *
 * @param {object} state — loaded state (mutated in place if reconciled)
 * @param {object} store — StateStore instance for persistence
 * @param {string} workspaceRoot
 * @param {number} [stallThresholdSeconds=600]
 * @returns {Promise<Array<{task_id: string, previous_status: string, new_status: string, message: string}>>}
 */
export async function startupReconciliation(state, store, workspaceRoot, stallThresholdSeconds = 600) {
  const reconciled = [];
  const now = Date.now();

  for (const task of (state.tasks || [])) {
    if (task.status !== "running") continue;

    const run = await getLatestRun(workspaceRoot, task.id);
    let shouldMark = false;
    let message = "";

    if (!run) {
      // Running with no run metadata (legacy task)
      shouldMark = true;
      message = "Startup reconciliation: task was in running state with no run metadata. No active Codex execution found. Marked as waiting for review.";
    } else {
      const ageSec = (now - new Date(run.last_heartbeat_at).getTime()) / 1000;
      const processAlive = isProcessAlive(run.codex_child_pid);

      if (!processAlive && ageSec > stallThresholdSeconds) {
        shouldMark = true;
        const dirty = isRepoDirty(workspaceRoot);
        if (dirty) {
          message = "Startup reconciliation: Codex appears stopped and repo has uncommitted changes. Marked as waiting for review.";
        } else {
          message = "Startup reconciliation: Codex appears stopped with no active process and stale heartbeat. Marked as waiting for review.";
        }
      }

      // If process is alive but exceeded regular timeout, use existing timeout handling
      if (processAlive && ageSec > stallThresholdSeconds) {
        // Process is still alive but very stale — don't auto-kill, just flag
        shouldMark = true;
        message = "Startup reconciliation: Codex process (PID " + run.codex_child_pid + ") is still running but heartbeat is stale (" + Math.round(ageSec) + "s). Marked as waiting for review.";
      }
    }

    if (shouldMark) {
      const prevStatus = task.status;
      task.status = "waiting_for_review";
      task.result = task.result || {};
      task.result.kind = "codex_stalled";
      task.result.reconciliation_message = message;
      task.result.reconciled_at = new Date().toISOString();
      task.logs = task.logs || [];
      task.logs.push({ time: new Date().toISOString(), message });

      reconciled.push({
        task_id: task.id,
        previous_status: prevStatus,
        new_status: "waiting_for_review",
        message
      });
    }
  }

  if (reconciled.length > 0) {
    try { await store.save(); } catch {}
  }

  return reconciled;
}

/**
 * Append a recovery log entry to a task and save the store.
 *
 * @param {object} store — StateStore instance
 * @param {string} taskId
 * @param {string} message — log message
 */
export async function appendTaskRecoveryLog(store, taskId, message) {
  const state = await store.load();
  const task = (state.tasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  task.logs = task.logs || [];
  task.logs.push({ time: new Date().toISOString(), message });
  task.updated_at = new Date().toISOString();
  await store.save();
}

// ---------------------------------------------------------------------------
// Recovery actions
// ---------------------------------------------------------------------------

/**
 * Perform a recovery action on a stuck task.
 *
 * Supported actions:
 *   - inspect_only:        Return diagnostics without making changes.
 *   - mark_waiting_review:  Mark task as waiting_for_review with codex_stalled kind.
 *   - mark_failed:         Mark task as failed.
 *   - reset_to_assigned:   Reset task status to "assigned" (removes assignee lock if stuck).
 *   - finalize_if_result_json: If result.json exists, finalize task as completed using it.
 *   - kill_process_if_alive: Kill the Codex child process if it's still alive.
 *
 * @param {object} store — StateStore instance
 * @param {object} config — server config with defaultWorkspaceRoot, stallThresholdSeconds
 * @param {string} taskId
 * @param {string} action — one of the supported actions
 * @returns {Promise<object>} recovery result with outcome and notes
 */
export async function recoverTask(store, config, taskId, action) {
  const state = await store.load();
  const task = (state.tasks || []).find((t) => t.id === taskId);
  if (!task) return { error: `task not found: ${taskId}` };

  const workspaceRoot = config.defaultWorkspaceRoot;
  const run = await getLatestRun(workspaceRoot, taskId);
  const outcome = { task_id: taskId, action, previous_status: task.status, new_status: task.status };

  switch (action) {
    case "inspect_only": {
      const diag = await diagnoseTask(state, workspaceRoot, taskId, config.codexStallThreshold || 600);
      outcome.diagnostics = diag;
      outcome.changes_made = false;
      outcome.message = "Inspection only. No changes made.";
      break;
    }

    case "mark_waiting_review": {
      task.status = "waiting_for_review";
      task.result = task.result || {};
      task.result.kind = "codex_stalled";
      task.result.recovery_action = action;
      task.result.recovered_at = new Date().toISOString();
      task.logs = task.logs || [];
      task.logs.push({ time: new Date().toISOString(), message: "[recovery] Task marked as waiting_for_review (codex_stalled) via recover_stuck_task." });
      outcome.new_status = "waiting_for_review";
      outcome.changes_made = true;
      outcome.message = "Task marked as waiting_for_review with kind=codex_stalled. Repo changes (if any) were preserved.";
      break;
    }

    case "mark_failed": {
      task.status = "failed";
      task.result = task.result || {};
      task.result.kind = "codex_failed";
      task.result.recovery_action = action;
      task.result.recovered_at = new Date().toISOString();
      task.logs = task.logs || [];
      task.logs.push({ time: new Date().toISOString(), message: "[recovery] Task marked as failed via recover_stuck_task." });
      outcome.new_status = "failed";
      outcome.changes_made = true;
      outcome.message = "Task marked as failed. Repo changes (if any) were preserved.";
      break;
    }

    case "reset_to_assigned": {
      task.status = "assigned";
      task.result = task.result || {};
      task.result.kind = "codex_reset";
      task.result.recovery_action = action;
      task.result.recovered_at = new Date().toISOString();
      task.logs = task.logs || [];
      task.logs.push({ time: new Date().toISOString(), message: "[recovery] Task reset to assigned status via recover_stuck_task." });
      outcome.new_status = "assigned";
      outcome.changes_made = true;
      outcome.message = "Task reset to assigned. It will be picked up by the next worker tick.";
      break;
    }

    case "finalize_if_result_json": {
      let resultJsonPath = run?.result_json_path;
      if (!resultJsonPath && workspaceRoot) {
        // Try legacy path
        const goalId = task.goal_id;
        if (goalId) {
          resultJsonPath = join(workspaceRoot, ".gptwork/goals", goalId, "result.json");
        }
      }

      let resultData = null;
      if (resultJsonPath && existsSync(resultJsonPath)) {
        try {
          resultData = JSON.parse(await readFile(resultJsonPath, "utf8"));
        } catch {}
      }

      if (resultData && resultData.status === "completed") {
        task.status = "completed";
        task.result = task.result || {};
        task.result.kind = "codex_executed";
        task.result.summary = resultData.summary || "Finalized from result.json after recovery";
        task.result.completed_at = new Date().toISOString();
        task.result.recovery_action = action;
        task.result.recovered_at = new Date().toISOString();
        task.logs = task.logs || [];
        task.logs.push({ time: new Date().toISOString(), message: "[recovery] Task finalized from result.json via recover_stuck_task." });
        outcome.new_status = "completed";
        outcome.changes_made = true;
        outcome.message = "Task finalized as completed using result.json.";
        // Refresh the run's result_json_path
        if (run) {
          try {
            const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
            await updateRunHeartbeat(runFilePath, "completed", { result_json_path: resultJsonPath });
          } catch {}
        }
      } else {
        outcome.changes_made = false;
        outcome.message = "No valid result.json found to finalize. Use a different recovery action.";
      }
      break;
    }

    case "kill_process_if_alive": {
      if (run && run.codex_child_pid && isProcessAlive(run.codex_child_pid)) {
        try {
          process.kill(-run.codex_child_pid, "SIGTERM");
          // Grace period then SIGKILL
          setTimeout(() => {
            try {
              if (isProcessAlive(run.codex_child_pid)) {
                process.kill(-run.codex_child_pid, "SIGKILL");
              }
            } catch {}
          }, 3000);
        } catch {}
        task.logs = task.logs || [];
        task.logs.push({ time: new Date().toISOString(), message: "[recovery] Sent SIGTERM to Codex process group (PID " + run.codex_child_pid + ") via recover_stuck_task." });
        outcome.changes_made = true;
        outcome.message = "Sent SIGTERM to Codex process group PID " + run.codex_child_pid + ". Use diagnose_task to verify it exited.";
        // Update run heartbeat
        if (run.run_id) {
          try {
            const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
            await updateRunHeartbeat(runFilePath, "failed", { exit_code: -15 });
          } catch {}
        }
      } else {
        outcome.changes_made = false;
        outcome.message = "No active Codex process found to kill.";
      }
      break;
    }

    default:
      return { error: `Unknown action: ${action}. Supported: inspect_only, mark_waiting_review, mark_failed, reset_to_assigned, finalize_if_result_json, kill_process_if_alive` };
  }

  task.updated_at = new Date().toISOString();
  await store.save();

  // Append run heartbeat for status changes
  if (run && run.run_id && action !== "inspect_only" && action !== "kill_process_if_alive") {
    try {
      const runFilePath = getRunFilePath(workspaceRoot, taskId, run.run_id);
      fireHeartbeat(runFilePath, outcome.new_status);
    } catch {}
  }

  return outcome;
}
