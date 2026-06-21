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
