import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseGitHubUrl } from "./repo-registry.mjs";

export function runGit(repoDir, args, { timeout = 15000, maxBuffer = 1000000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repoDir || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeout}ms`));
    }, timeout);

    function collect(target, chunk, currentBytes) {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > maxBuffer && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error(`git ${args.join(" ")} exceeded max output ${maxBuffer} bytes`));
      }
      if (!settled) target.push(chunk);
      return nextBytes;
    }

    child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (code !== 0) {
        const error = new Error(stderrBuffer.toString("utf8").trim() || `git ${args.join(" ")} exited ${code}`);
        error.code = code;
        error.stderr = stderrBuffer.toString("utf8");
        error.stdout = stdoutBuffer.toString("utf8");
        reject(error);
        return;
      }
      resolvePromise({ stdout: stdoutBuffer, stderr: stderrBuffer });
    });
  });
}

export async function gitText(repoDir, args, options) {
  try {
    const result = await runGit(repoDir, args, options);
    return result.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
}

export async function gitBuffer(repoDir, args, options) {
  const result = await runGit(repoDir, args, options);
  return result.stdout;
}

/** Walk up from startDir looking for a .git directory. */
export function _findGitDir(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a repo spec to a local Git checkout directory.
 *
 * Resolution order:
 *  1. repo_path given -> resolve (walk up to .git)
 *  2. repo given      -> look up in registry, then canonical workspace path
 *  3. Fallback        -> walk up from cwd
 */
export function resolveRepo(fromRepo, fromPath, registry, defaultWorkspaceRoot) {
  if (fromPath) {
    const gitDir = _findGitDir(fromPath);
    if (gitDir) return gitDir;
    return null;
  }

  if (fromRepo) {
    if (registry) {
      const repoId = registry.resolveRepoId(fromRepo);
      if (repoId) {
        const record = registry.get(repoId);
        if (record && record.canonical_path) {
          const gitDir = _findGitDir(record.canonical_path);
          if (gitDir) return gitDir;
        }
      }
    }
    const parsed = parseGitHubUrl(fromRepo);
    if (parsed && defaultWorkspaceRoot) {
      const candidate = join(defaultWorkspaceRoot, `repos/${parsed.repo_id}`);
      const gitDir = _findGitDir(candidate);
      if (gitDir) return gitDir;
    }
  }

  return _findGitDir(process.cwd());
}

export async function getRemoteUrl(repoDir, remote) {
  return gitText(repoDir, ["remote", "get-url", remote]);
}

export async function getCurrentBranch(repoDir) {
  const ref = await gitText(repoDir, ["symbolic-ref", "HEAD"]);
  if (ref && ref.startsWith("refs/heads/")) return ref.slice(11);
  return null;
}

export async function getLocalHead(repoDir) {
  return gitText(repoDir, ["rev-parse", "HEAD"]);
}

export async function getTrackingRef(repoDir, remote, branch) {
  const ref = `refs/remotes/${remote}/${branch}`;
  const sha = await gitText(repoDir, ["rev-parse", ref]);
  if (sha) return { trackingRef: ref, trackingHead: sha };
  return { trackingRef: null, trackingHead: null };
}

export async function getRemoteHeadViaLsRemote(repoDir, remote, branch) {
  const remoteUrl = await getRemoteUrl(repoDir, remote);
  if (!remoteUrl) return null;
  const out = await gitText(null, ["ls-remote", remoteUrl, `refs/heads/${branch}`]);
  if (out) {
    const parts = out.split(/\s+/);
    return parts[0] || null;
  }
  return null;
}

export async function getDirtyInfo(repoDir) {
  const out = await gitText(repoDir, ["status", "--porcelain"]);
  if (!out) return { dirty: false, dirtyPaths: [] };
  const lines = out.split("\n").filter(Boolean);
  return { dirty: lines.length > 0, dirtyPaths: lines.map((line) => line.replace(/^.. /, "")).filter(Boolean) };
}

export function parseNameStatusLines(lines, limit) {
  return lines.slice(0, limit).map((line) => {
    const parts = line.split("\t");
    const status = parts[0];
    const filePath = parts[1];
    let old_path;
    if ((status[0] === "R" || status[0] === "C") && parts.length >= 3) {
      old_path = parts[1];
      return { status, path: parts[2], old_path };
    }
    return { status, path: filePath };
  });
}

export function defaultRemoteRef(defaultRemote, defaultBranch) {
  return `${defaultRemote || "origin"}/${defaultBranch || "main"}`;
}

// ---------------------------------------------------------------------------
// Tool handlers  (called from gptwork-server.mjs createTools)
// ---------------------------------------------------------------------------
