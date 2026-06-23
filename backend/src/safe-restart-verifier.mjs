import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Startup verification (Phase C)
// ---------------------------------------------------------------------------

/**
 * Verify a restart marker after service startup.
 *
 * Compares the expected commit/running_commit/local HEAD/remote HEAD
 * to determine if the deployment was successful.
 *
 * For npm restart markers (restart_kind="npm"), if the expected_commit matches
 * the running commit OR the old_pid differs from the current pid (meaning a
 * restart actually occurred), the marker is considered verified.
 *
 * For systemd restart markers (restart_kind="systemd"), the original strict
 * commit matching logic is used.
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
    restart_kind: marker.restart_kind || "npm",
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

    // -------------------------------------------------------------------
    // Verification logic, mode-aware
    // -------------------------------------------------------------------

    const restartKind = marker.restart_kind || "npm";
    const oldPid = marker.old_pid;
    const currentPid = process.pid;

    let verified = true;
    const failures = [];
    const reasons = [];

    // Check 1: expected_commit vs running_commit
    if (marker.expected_commit) {
      const ec = marker.expected_commit;
      const shortPrefixMatch = ec.length < 40 && ec.length >= 4 && localHead.startsWith(ec);
      if (ec !== localHead && !shortPrefixMatch) {
        if (restartKind === "npm" && oldPid && oldPid !== currentPid) {
          // npm mode: pid change alone confirms restart happened
          reasons.push("expected_commit mismatch overridden: old_pid changed (restart confirmed)");
        } else {
          verified = false;
          const reason = ec.length < 40
            ? `expected commit "${ec}" is not a prefix of running commit "${localHead}"`
            : `expected commit "${ec}" does not match running commit "${localHead}"`;
          failures.push(reason);
        }
      } else {
        reasons.push(`expected_commit matches running_commit (${localHead.slice(0, 12)})`);
      }
    }

    // Check 2: old_pid verification (npm mode)
    if (restartKind === "npm" && oldPid) {
      diagnostics.old_pid = oldPid;
      diagnostics.current_pid = currentPid;
      if (oldPid !== currentPid) {
        reasons.push(`pid changed: ${oldPid} -> ${currentPid} (restart confirmed)`);
      } else {
        reasons.push(`pid unchanged: ${currentPid} (same process)`);
        // Not a failure per se, but note it
      }
    }

    // Check 3: remote head match
    if (marker.expected_remote_head && diagnostics.remote_head &&
        marker.expected_remote_head !== diagnostics.remote_head) {
      if (restartKind === "npm" && oldPid && oldPid !== currentPid) {
        reasons.push("remote_head mismatch overridden: pid change confirms restart");
      } else {
        verified = false;
        failures.push(`expected remote HEAD ${marker.expected_remote_head} but remote is ${diagnostics.remote_head}`);
      }
    }

    diagnostics.verified = verified;
    diagnostics.failures = failures;
    diagnostics.verification_reasons = reasons;
    return { verified, diagnostics };

  } catch (e) {
    diagnostics.error = `Verification failed: ${e.message}`;
    return { verified: false, diagnostics };
  }
}
