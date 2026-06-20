/**
 * safe-restart.mjs — Safe two-phase restart protocol for GPTWork service restarts.
 *
 * Provides:
 * - Pending restart marker store under .gptwork/pending-restarts/<task_id>.json
 * - scheduleServiceRestart: writes marker + schedules detached systemd restart
 * - scanPendingRestartMarkers: read all pending markers for startup verification
 * - verifyRestartMarker: compare running_commit/local HEAD/remote HEAD after service restart
 * - updateRestartMarkerStatus: update marker status and append logs
 *
 * The goal is to prevent tasks from getting stuck when Codex needs to restart
 * the gptwork-mcp.service that is running the worker itself. The protocol is:
 *
 * Phase A: task finishes work, writes results, calls scheduleServiceRestart
 * Phase B: detached restart runner restarts service after safe checkpoint
 * Phase C: on startup, GPTWork scans markers, verifies, finalizes tasks
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_RESTARTS_DIR = ".gptwork/pending-restarts";
const SERVICE_NAME = "gptwork-mcp.service";

const VALID_STATUSES = ["pending", "scheduled", "restarted", "verified", "failed"];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the pending restarts directory for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function getPendingRestartsDir(workspaceRoot) {
  return join(workspaceRoot, PENDING_RESTARTS_DIR);
}

/**
 * Get the path to a specific restart marker file.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {string}
 */
export function getRestartMarkerPath(workspaceRoot, taskId) {
  return join(getPendingRestartsDir(workspaceRoot), String(taskId) + ".json");
}

// ---------------------------------------------------------------------------
// Marker CRUD
// ---------------------------------------------------------------------------

/**
 * Write a pending restart marker file.
 * The marker is the durable checkpoint that survives service restart.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {object} fields
 * @param {string} [fields.requested_by="codex"]
 * @param {string} [fields.service_name="gptwork-mcp.service"]
 * @param {string|null} [fields.expected_commit=null] - SHA of the commit we expect after restart
 * @param {string|null} [fields.expected_remote_head=null] - SHA of the remote HEAD we expect
 * @param {string|null} [fields.repo_path=null]
 * @param {string} [fields.restart_kind="systemd"]
 * @returns {Promise<object>} the written marker
 */
export async function writePendingRestartMarker(workspaceRoot, taskId, fields = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  if (!taskId) throw new Error("taskId is required");

  const dir = getPendingRestartsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const marker = {
    task_id: taskId,
    requested_at: now,
    requested_by: fields.requested_by || "codex",
    service_name: fields.service_name || SERVICE_NAME,
    expected_commit: fields.expected_commit || null,
    expected_remote_head: fields.expected_remote_head || null,
    repo_path: fields.repo_path || null,
    restart_kind: fields.restart_kind || "systemd",
    status: "pending",
    logs: [
      { time: now, message: `Restart marker created by ${fields.requested_by || "codex"} with status=pending` }
    ],
    attempts: 0
  };

  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");

  return marker;
}

/**
 * Load a restart marker for a specific task.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function loadRestartMarker(workspaceRoot, taskId) {
  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Update a restart marker's status and append a log entry.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {string} newStatus — one of pending|scheduled|restarted|verified|failed
 * @param {object} [extraFields={}] - additional fields to merge into the marker
 * @returns {Promise<object>} updated marker
 */
export async function updateRestartMarkerStatus(workspaceRoot, taskId, newStatus, extraFields = {}) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid restart marker status: ${newStatus}. Valid values: ${VALID_STATUSES.join(", ")}`);
  }

  const marker = await loadRestartMarker(workspaceRoot, taskId);
  if (!marker) {
    throw new Error(`No restart marker found for task: ${taskId}`);
  }

  const now = new Date().toISOString();
  marker.status = newStatus;
  marker.logs = marker.logs || [];
  marker.logs.push({ time: now, message: `Status changed to: ${newStatus}` });

  for (const [key, value] of Object.entries(extraFields)) {
    if (value !== undefined) {
      marker[key] = value;
    }
  }

  if (newStatus === "restarted") {
    marker.attempts = (marker.attempts || 0) + 1;
  }

  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");

  return marker;
}

/**
 * Scan all pending restart markers in the workspace.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<object[]>} array of marker objects
 */
export async function scanPendingRestartMarkers(workspaceRoot) {
  const dir = getPendingRestartsDir(workspaceRoot);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const markers = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const marker = await loadRestartMarker(workspaceRoot, taskId);
        if (marker) markers.push(marker);
      } catch {
        // skip unreadable markers
      }
    }

    // Sort by requested_at descending
    markers.sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    return markers;
  } catch {
    return [];
  }
}

/**
 * Synchronous version of scanPendingRestartMarkers for use in synchronous contexts
 * (e.g., gptwork_doctor suggested_next_actions).
 * Uses readdirSync / readFileSync instead of async variants.
 *
 * @param {string} workspaceRoot
 * @returns {object[]} array of marker objects
 */
export function scanPendingRestartMarkersSync(workspaceRoot) {
  const dir = getPendingRestartsDir(workspaceRoot);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const markers = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
        const data = readFileSync(markerPath, "utf8");
        markers.push(JSON.parse(data));
      } catch {
        // skip unreadable markers
      }
    }
    markers.sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    return markers;
  } catch {
    return [];
  }
}

/**
 * Remove a restart marker file.
 *
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @returns {Promise<boolean>} true if the marker was removed
 */
export async function removeRestartMarker(workspaceRoot, taskId) {
  const markerPath = getRestartMarkerPath(workspaceRoot, taskId);
  try {
    await rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schedule detached restart
// ---------------------------------------------------------------------------

/**
 * Schedule a detached service restart using the safest available mechanism.
 *
 * Strategy:
 *   1. First tries `systemd-run --user --on-active=2s --unit=<unit> <cmd>`
 *      which is fully detached and survives the current process being killed.
 *   2. Falls back to `(sleep 2 && <cmd>) &` with disown/nohup if systemd-run
 *      is unavailable.
 *
 * @param {object} options
 * @param {string} options.serviceName - systemd service name
 * @param {string} [options.taskId] - for log message only
 * @returns {{ method: string, command: string, scheduled: boolean, output?: string, error?: string }}
 */
export function scheduleDetachedRestart(options = {}) {
  const serviceName = options.serviceName || SERVICE_NAME;
  const taskId = options.taskId || "";
  const dryRun = Boolean(options.dryRun);
  const unitName = taskId
    ? `gptwork-restart-${String(taskId).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : `gptwork-restart-${Date.now()}`;
  const systemctlCmd = `systemctl --user restart ${serviceName}`;

  // Strategy 1: systemd-run --user (preferred, fully detached)
  const systemdRunCmd = `systemd-run --user --on-active=2s --unit=${unitName} ${systemctlCmd}`;
  if (dryRun) {
    return {
      method: "dry-run",
      command: systemdRunCmd,
      scheduled: true,
      output: "dry run: restart not scheduled"
    };
  }
  try {
    const out = execSync(systemdRunCmd, {
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      method: "systemd-run",
      command: systemdRunCmd,
      scheduled: true,
      output: out.trim()
    };
  } catch (e) {
    // systemd-run may not be available, try fallback
  }

  // Strategy 2: disowned background subshell
  const bgCmd = `(sleep 2 && ${systemctlCmd}) >/dev/null 2>&1 &`;
  try {
    const out = execSync(bgCmd, {
      timeout: 5000,
      encoding: "utf8",
      shell: "/bin/sh",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      method: "background-shell",
      command: bgCmd,
      scheduled: true,
      output: out.trim()
    };
  } catch (e2) {
    return {
      method: "failed",
      command: systemctlCmd,
      scheduled: false,
      error: `Cannot schedule detached restart: ${e2.message}`
    };
  }
}

// ---------------------------------------------------------------------------
// High-level schedule_service_restart
// ---------------------------------------------------------------------------

/**
 * Schedule a safe two-phase service restart.
 *
 * Phase A:
 *   1. Writes pending restart marker with expected commit/repo state
 *   2. Appends a task log entry if task state is available
 * Phase B:
 *   3. Schedules detached restart using systemd-run or background shell
 *   4. Returns structured info about the scheduled restart
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} options.taskId
 * @param {string} [options.requestedBy="codex"]
 * @param {string} [options.serviceName="gptwork-mcp.service"]
 * @param {string|null} [options.expectedCommit=null]
 * @param {string|null} [options.expectedRemoteHead=null]
 * @param {string|null} [options.repoPath=null]
 * @param {object} [options.store=null] - optional StateStore to append task log
 * @returns {Promise<object>} structured result
 */
export async function scheduleServiceRestart(options = {}) {
  const {
    workspaceRoot,
    taskId,
    requestedBy = "codex",
    serviceName = SERVICE_NAME,
    expectedCommit = null,
    expectedRemoteHead = null,
    repoPath = null,
    store = null,
    dryRun = false,
    restartScheduler = scheduleDetachedRestart
  } = options;

  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  if (!taskId) throw new Error("taskId is required");

  // P0: Validate workspaceRoot is not a repo-local path
  const _wsRootValidation = validateWorkspaceRoot(workspaceRoot);
  if (!_wsRootValidation.valid) {
    throw new Error(_wsRootValidation.reason);
  }

  const startedAt = Date.now();

  // P2.0b.3: Prefer result.json commit when available.
  //   Priority: result.json commit > explicit expected_commit (with HEAD match) > local HEAD default
  let resultJsonCommit = null;
  if (store && workspaceRoot && taskId) {
    try {
      const state = await store.load();
      const task = (state.tasks || []).find(t => t.id === taskId);
      if (task && task.goal_id) {
        const resultJsonPath = join(workspaceRoot, ".gptwork/goals", task.goal_id, "result.json");
        if (existsSync(resultJsonPath)) {
          const text = await readFile(resultJsonPath, "utf8");
          const data = JSON.parse(text);
          if (typeof data.commit === "string" && data.commit.length > 0) {
            resultJsonCommit = data.commit;
          }
        }
      }
    } catch {
      // Non-fatal: fall back to existing expected_commit resolution
    }
  }

  // P2.0b.4: Normalize result_json_commit to full SHA before writing marker.
  // Short hashes (e.g. "2fe8ed1") from result.json would fail Phase C strict comparison
  // against the full running_commit, so we resolve them via git rev-parse on the target repo.
  if (resultJsonCommit && repoPath && resultJsonCommit.length < 40) {
    try {
      const fullSha = execSync(`git rev-parse ${resultJsonCommit}`, {
        cwd: repoPath, timeout: 5000, encoding: "utf8"
      }).trim();
      if (/^[0-9a-f]{40}$/i.test(fullSha)) {
        resultJsonCommit = fullSha;
      } else {
        console.warn(`[safe-restart] Could not resolve result.json commit "${resultJsonCommit}" to a full SHA (got "${fullSha}")`);
        resultJsonCommit = null;
      }
    } catch (e) {
      console.warn(`[safe-restart] Could not resolve result.json commit "${resultJsonCommit}" in repo ${repoPath}: ${e.message}`);
      resultJsonCommit = null;
    }
  }

  // P2.0b.2: Resolve expected_commit from local HEAD when absent; reject on mismatch.
  let resolvedCommit = expectedCommit;
  let expectedCommitSource = null;
  if (resultJsonCommit) {
    // P2.0b.3: result.json commit takes priority over all other sources
    resolvedCommit = resultJsonCommit;
    expectedCommitSource = "result_json_commit";
  } else if (repoPath) {
    try {
      const localHead = execSync("git rev-parse HEAD", {
        cwd: repoPath, timeout: 5000, encoding: "utf8"
      }).trim();
      if (expectedCommit) {
        // Normalize short expected_commit to full SHA before comparison.
        let normalizedCommit = expectedCommit;
        if (normalizedCommit.length < 40 && repoPath) {
          try {
            const fullSha = execSync(`git rev-parse ${normalizedCommit}`, {
              cwd: repoPath, timeout: 5000, encoding: "utf8"
            }).trim();
            if (/^[0-9a-f]{40}$/i.test(fullSha)) {
              normalizedCommit = fullSha;
            }
          } catch (e) {
            console.warn(`[safe-restart] Could not resolve short expected_commit "${expectedCommit}" in repo ${repoPath}: ${e.message}`);
          }
        }
        // P2.0b.1: Reject stale expected_commit before writing restart marker.
        if (localHead !== normalizedCommit) {
          const duration = Date.now() - startedAt;
          return {
            ok: false, task_id: taskId, service_name: serviceName,
            error: "expected_commit_mismatch",
            expected_commit: normalizedCommit,
            local_head: localHead,
            duration_ms: duration,
            warning: `Cannot schedule restart: expected_commit ${normalizedCommit} does not match local HEAD ${localHead}`
          };
        }
        resolvedCommit = normalizedCommit;
        expectedCommitSource = "explicit";
      } else {
        // P2.0b.2: Default from local HEAD when expected_commit absent
        resolvedCommit = localHead;
        expectedCommitSource = "local_head";
      }
    } catch (e) {
      console.warn(`[safe-restart] Could not resolve local HEAD: ${e.message}`);
    }
  }

  // Step 1: Write pending restart marker
  await writePendingRestartMarker(workspaceRoot, taskId, {
    requested_by: requestedBy,
    service_name: serviceName,
    expected_commit: resolvedCommit,
    expected_remote_head: expectedRemoteHead,
    repo_path: repoPath,
  });

  // Step 2: Optionally append task log
  if (store && typeof store.load === "function") {
    try {
      const state = await store.load();
      const task = (state.tasks || []).find((t) => t.id === taskId);
      if (task) {
        task.logs = task.logs || [];
        task.logs.push({
          time: new Date().toISOString(),
          message: `[safe-restart] Pending restart marker written for ${serviceName}. Expected commit: ${resolvedCommit || "(unchanged)"}`
        });
        task.updated_at = new Date().toISOString();
        await store.save();
      }
    } catch {
      // non-fatal
    }
  }

  // Step 3: Schedule detached restart
  const restart = restartScheduler({
    serviceName,
    taskId,
    dryRun,
  });

  // Step 4: Update marker status based on scheduling result
  if (restart.scheduled) {
    await updateRestartMarkerStatus(workspaceRoot, taskId, "scheduled", {
      restart_method: restart.method,
      scheduled_at: new Date().toISOString()
    });
  } else {
    await updateRestartMarkerStatus(workspaceRoot, taskId, "failed", {
      failure_reason: restart.error || "unknown"
    });
  }

  const duration = Date.now() - startedAt;

  return {
    ok: restart.scheduled,
    task_id: taskId,
    service_name: serviceName,
    restart_scheduled: restart.scheduled,
    restart_method: restart.method,
    expected_commit: resolvedCommit,
    expected_commit_source: expectedCommitSource,
    expected_remote_head: expectedRemoteHead,
    duration_ms: duration,
    warning: !restart.scheduled
      ? (restart.error || "Failed to schedule detached restart")
      : undefined
  };
}


// ---------------------------------------------------------------------------
// Startup verification (Phase C)
// ---------------------------------------------------------------------------

/**
 * Verify a restart marker after service startup.
 *
 * Compares the expected commit/running_commit/local HEAD/remote HEAD
 * to determine if the deployment was successful.
 *
 * @param {object} marker - the restart marker object
 * @param {object} config
 * @param {string} [config.defaultRepoPath] - canonical repo path
 * @param {string} [config.defaultRemote] - git remote name
 * @param {string} [config.defaultBranch] - branch name
 * @returns {Promise<{ verified: boolean, diagnostics: object }>}
 */
export async function verifyRestartMarker(marker, config = {}) {
  if (!marker) {
    return { verified: false, diagnostics: { error: "no marker provided" } };
  }

  const repoPath = marker.repo_path || config.defaultRepoPath;
  const diagnostics = {
    task_id: marker.task_id,
    marker_status: marker.status,
    expected_commit: marker.expected_commit,
    expected_remote_head: marker.expected_remote_head,
  };

  if (!repoPath || !existsSync(join(repoPath, ".git"))) {
    diagnostics.error = "No git repo path available for verification";
    diagnostics.repo_path_checked = repoPath;
    return { verified: false, diagnostics };
  }

  try {
    const localHead = execSync("git rev-parse HEAD", {
      cwd: repoPath, timeout: 5000, encoding: "utf8"
    }).trim();
    diagnostics.running_commit = localHead;

    try {
      const remoteRef = `refs/heads/${config.defaultBranch || "main"}`;
      const remoteLine = execSync(`git ls-remote ${config.defaultRemote || "origin"} ${remoteRef} 2>/dev/null`, {
        cwd: repoPath, timeout: 5000, encoding: "utf8"
      }).trim();
      if (remoteLine) {
        diagnostics.remote_head = remoteLine.split(/\s+/)[0];
      }
    } catch {
      diagnostics.remote_head = null;
    }

    let verified = true;
    const failures = [];

    if (marker.expected_commit) {
      const ec = marker.expected_commit;
      // Accept if full match, or if short expected_commit is a prefix of running_commit.
      // Minimum prefix length (4) avoids ambiguous short ref matching.
      const shortPrefixMatch = ec.length < 40 && ec.length >= 4 && localHead.startsWith(ec);
      if (ec !== localHead && !shortPrefixMatch) {
        verified = false;
        const reason = ec.length < 40
          ? `expected commit "${ec}" is not a prefix of running commit "${localHead}"`
          : `expected commit "${ec}" does not match running commit "${localHead}"`;
        failures.push(reason);
      }
    }
    if (marker.expected_remote_head && diagnostics.remote_head &&
        marker.expected_remote_head !== diagnostics.remote_head) {
      verified = false;
      failures.push(`expected remote HEAD ${marker.expected_remote_head} but remote is ${diagnostics.remote_head}`);
    }

    diagnostics.verified = verified;
    diagnostics.failures = failures;
    return { verified, diagnostics };

  } catch (e) {
    diagnostics.error = `Verification failed: ${e.message}`;
    return { verified: false, diagnostics };
  }
}


// ---------------------------------------------------------------------------
// Misplaced marker detection and migration
// ---------------------------------------------------------------------------

/**
 * Validate that a workspace root is not pointing at a git repository path.
 *
 * Safe-restart markers must be stored under the canonical workspace `.gptwork`
 * directory, NOT under a repo-local `.gptwork` directory.  If the workspaceRoot
 * points inside a git repo (i.e. a `.git` subdirectory exists), it will produce
 * markers that the Phase C reconciliation cannot find.
 *
 * @param {string} workspaceRoot — the path to check
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot) {
    return { valid: false, reason: "workspaceRoot is required" };
  }
  if (existsSync(join(workspaceRoot, ".git"))) {
    return {
      valid: false,
      reason: `workspaceRoot points to a git repository path: ${workspaceRoot}. Use the workspace root (e.g. parent of repo), not the repo itself.`
    };
  }
  return { valid: true };
}

/**
 * The diagnostic key emitted when a safe-restart marker is found inside a
 * repo-local .gptwork/pending-restarts directory instead of the canonical
 * workspace-level .gptwork/pending-restarts.
 */
export const MISPLACED_MARKER_DIAGNOSTIC = "misplaced_safe_restart_marker";

/**
 * Scan for misplaced restart markers located under repo-local `.gptwork`
 * directories instead of the canonical workspace path.
 *
 * A "misplaced" marker was written to `repoPath/.gptwork/pending-restarts/`
 * rather than `workspaceRoot/.gptwork/pending-restarts/`.  This can happen
 * when Codex writes the marker file directly via `exec_command` instead of
 * calling the `schedule_service_restart` MCP tool, or when a caller passes
 * the repo path as `workspaceRoot`.
 *
 * @param {string[]} repoPaths — array of canonical repo paths to inspect
 * @returns {Array<{ repoPath: string, taskId: string, marker: object, markerPath: string }>}
 */
export function scanMisplacedMarkersSync(repoPaths) {
  if (!Array.isArray(repoPaths) || repoPaths.length === 0) return [];

  const results = [];
  for (const repoPath of repoPaths) {
    if (!repoPath) continue;
    const markerDir = join(repoPath, ".gptwork", "pending-restarts");
    let entries;
    try {
      entries = readdirSync(markerDir, { withFileTypes: true });
    } catch {
      continue; // no misplaced marker directory for this repo
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -5);
      try {
        const markerPath = join(markerDir, entry.name);
        const data = readFileSync(markerPath, "utf8");
        const marker = JSON.parse(data);
        results.push({ repoPath, taskId, marker, markerPath });
      } catch {
        // skip unreadable files
      }
    }
  }
  return results;
}

/**
 * Migrate a misplaced restart marker from a repo-local path to the canonical
 * workspace-level path.
 *
 * Reads the source marker from `repoPath/.gptwork/pending-restarts/<taskId>.json`,
 * writes an equivalent marker to `workspaceRoot/.gptwork/pending-restarts/`,
 * preserves the source marker's status (pending/scheduled/restarted), then
 * removes the misplaced source file.
 *
 * @param {string} workspaceRoot — canonical workspace root
 * @param {string} repoPath — repo path where the misplaced marker was found
 * @param {string} taskId — task ID
 * @returns {Promise<{ migrated: boolean, marker?: object, diagnostic?: string }>}
 */
export async function migrateMisplacedMarker(workspaceRoot, repoPath, taskId) {
  if (!workspaceRoot) {
    return { migrated: false, diagnostic: "workspaceRoot is required" };
  }
  if (!repoPath) {
    return { migrated: false, diagnostic: "repoPath is required" };
  }
  if (!taskId) {
    return { migrated: false, diagnostic: "taskId is required" };
  }

  const sourcePath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  let sourceMarker;
  try {
    sourceMarker = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch {
    return {
      migrated: false,
      diagnostic: "misplaced_safe_restart_marker: source marker not found or unreadable at " + sourcePath
    };
  }

  // Check if canonical marker already exists — skip if so
  const existing = await loadRestartMarker(workspaceRoot, taskId);
  if (existing) {
    // Canonical already exists; just remove the misplaced marker
    try { await rm(sourcePath, { force: true }); } catch {}
    return {
      migrated: false,
      diagnostic: "misplaced_safe_restart_marker: canonical marker already exists; removed duplicate",
      marker: existing
    };
  }

  // Write marker to canonical path
  const marker = await writePendingRestartMarker(workspaceRoot, taskId, {
    requested_by: sourceMarker.requested_by || "codex",
    service_name: sourceMarker.service_name || "gptwork-mcp.service",
    expected_commit: sourceMarker.expected_commit || null,
    expected_remote_head: sourceMarker.expected_remote_head || null,
    repo_path: sourceMarker.repo_path || repoPath,
  });

  // Preserve the source marker's status (already written as "pending" above)
  if (sourceMarker.status && sourceMarker.status !== "pending") {
    try {
      await updateRestartMarkerStatus(workspaceRoot, taskId, sourceMarker.status, {
        restart_method: sourceMarker.restart_method || null,
        scheduled_at: sourceMarker.scheduled_at || null,
      });
    } catch {
      // non-fatal — marker exists at least as "pending"
    }
  }

  // Remove the misplaced source file
  try {
    await rm(sourcePath, { force: true });
  } catch {
    // non-fatal
  }

  return { migrated: true, marker };
}

/**
 * Get a human-readable diagnostic for a misplaced restart marker.
 *
 * @param {object} result — the result from scanMisplacedMarkersSync item
 * @returns {string} diagnostic string
 */
export function getMisplacedMarkerDiagnostic({ repoPath, taskId, marker } = {}) {
  if (!repoPath || !taskId) {
    return "misplaced_safe_restart_marker: insufficient data";
  }
  const status = marker?.status || "unknown";
  const commit = marker?.expected_commit || "(none)";
  return [
    "misplaced_safe_restart_marker",
    `task=${taskId}`,
    `status=${status}`,
    `expected_commit=${commit}`,
    `repo_path=${repoPath}`,
    `expected_path=${join(repoPath, ".gptwork", "pending-restarts", taskId + ".json")}`,
  ].join(" ");
}

/**
 * Remove a misplaced restart marker file without migrating it.
 * Used when the canonical marker already exists or the task cannot be recovered.
 *
 * @param {string} repoPath — repo path where the misplaced marker was found
 * @param {string} taskId — task ID
 * @returns {Promise<boolean>} true if removed (or not found)
 */
export async function removeMisplacedMarker(repoPath, taskId) {
  if (!repoPath || !taskId) return false;
  const markerPath = join(repoPath, ".gptwork", "pending-restarts", taskId + ".json");
  try {
    await rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
