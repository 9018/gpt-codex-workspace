import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SERVICE_NAME, updateRestartMarkerStatus, writePendingRestartMarker } from "./safe-restart-marker-store.mjs";
import { validateWorkspaceRoot } from "./safe-restart-misplaced-markers.mjs";
import { scheduleDetachedRestart } from "./safe-restart-detached-scheduler.mjs";

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
    restartScheduler = scheduleDetachedRestart,
    restartConfig = null
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
  //   Priority: result.json commit (verified against repo HEAD via P2.0b.5) > explicit expected_commit (with HEAD match) > local HEAD default
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

  
  // P2.0b.5: If result.json commit conflicts with repo HEAD, prefer HEAD and record diagnostic.
  // The result.json commit can be stale (e.g., from a previous task run) while the canonical
  // repo has advanced. Using a stale expected_commit causes a false restart failure during
  // Phase C verification, so we detect the conflict and use repo HEAD instead.
  let resultJsonCommitRejected = null;
  if (resultJsonCommit && repoPath) {
    try {
      const localHead = execSync("git rev-parse HEAD", {
        cwd: repoPath, timeout: 5000, encoding: "utf8"
      }).trim();
      if (resultJsonCommit !== localHead) {
        console.warn(
          "[safe-restart] result.json commit \"" + resultJsonCommit + "\" differs from " +
          "repo HEAD \"" + localHead + "\". Using repo HEAD for expected_commit."
        );
        resultJsonCommitRejected = resultJsonCommit;
        resultJsonCommit = null; // fall through to HEAD-based resolution below
      }
    } catch (e) {
      console.warn(
        "[safe-restart] Could not compare result.json commit against repo HEAD: " + e.message
      );
      // Keep resultJsonCommit as-is on error; the marker will use the result.json value,
      // which is better than nothing.
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
  const markerFields = {
    requested_by: requestedBy,
    service_name: serviceName,
    expected_commit: resolvedCommit,
    expected_remote_head: expectedRemoteHead,
    repo_path: repoPath,
    restart_kind: restartConfig ? restartConfig.markerKind || "npm" : "npm",
    old_pid: process.pid,
  };
  if (resultJsonCommitRejected) {
    markerFields.result_json_commit_rejected = resultJsonCommitRejected;
  }
  await writePendingRestartMarker(workspaceRoot, taskId, markerFields);

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
    strategy: restartConfig
  });

  // Step 4: Update marker status based on scheduling result
  if (restart.scheduled) {
    await updateRestartMarkerStatus(workspaceRoot, taskId, "scheduled", {
      restart_method: restart.method,
    restart_mode: restart.restart_mode || (restartConfig ? restartConfig.mode : "npm"),
    restart_marker_kind: restartConfig ? restartConfig.markerKind : "npm",
      scheduled_at: new Date().toISOString()
    });
  } else {
    await updateRestartMarkerStatus(workspaceRoot, taskId, "failed", {
      failure_reason: restart.error || "unknown"
    });
  }

  const duration = Date.now() - startedAt;

  const result = {
    ok: restart.scheduled,
    task_id: taskId,
    service_name: serviceName,
    restart_scheduled: restart.scheduled,
    restart_method: restart.method,
    restart_mode: restart.restart_mode || (restartConfig ? restartConfig.mode : "npm"),
    restart_marker_kind: restartConfig ? restartConfig.markerKind : "npm",
    expected_commit: resolvedCommit,
    expected_commit_source: expectedCommitSource,
    expected_remote_head: expectedRemoteHead,
    duration_ms: duration,
    warning: !restart.scheduled
      ? (restart.error || "Failed to schedule detached restart")
      : undefined
  };
  // Add diagnostic for result.json commit rejection (P2.0b.5)
  if (resultJsonCommitRejected) {
    result.warning = (
      result.warning
        ? result.warning + "; "
        : ""
    ) + `result.json commit "${resultJsonCommitRejected}" did not match repo HEAD "${resolvedCommit}"; used HEAD`;
    result.result_json_commit_rejected = resultJsonCommitRejected;
  }
  return result;
}
