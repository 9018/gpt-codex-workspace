/**
 * verification-evidence.mjs — Evidence collection helpers for the acceptance agent.
 *
 * Collects and structures evidence from git, logs, and task results for
 * acceptance verification.
 *
 * Requirements (P0):
 * - Collect git status, diff stat, changed files, result json parse,
 *   verification log, patch evidence
 * - Save evidence files: implementation-diff.patch, verification.log,
 *   acceptance.evidence.json
 */

import { execFileSync } from 'node:child_process';
import { readFile, access, writeFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Collect verification evidence for a completed task.
 *
 * @param {object} options
 * @param {string} [options.repoPath] - Path to the canonical git repo
 * @param {string} [options.worktreePath] - Task worktree path (preferred for git ops)
 * @param {string} [options.outputDir] - Directory to save evidence files
 * @param {string} [options.resultJsonPath] - Path to result.json to read/parse
 * @param {Array}  [options.acceptanceFindings] - Existing acceptance findings to include
 * @returns {Promise<object>} Evidence object with paths and parsed data
 */
export async function collectVerificationEvidence({
  repoPath,
  worktreePath,
  outputDir,
  resultJsonPath,
  acceptanceFindings,
  baseSha,
} = {}) {
  const gitPath = worktreePath || repoPath;
  const evidence = {
    implementation_diff_patch: null,
    verification_log: null,
    acceptance_evidence_json: null,
    evidence_paths: {},
    git_status: null,
    diff_stat: null,
    changed_files: [],
    result_json: null,
  };

  // 1. Collect git status
  if (gitPath) {
    try {
      const statusStdout = execFileSync('git', ['status', '--porcelain'], {
        cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      evidence.git_status = statusStdout || null;
    } catch {
      evidence.git_status = null;
    }
  }

  // Determine diff range: use baseSha..HEAD when available, fall back to HEAD~1..HEAD
  const diffRange = baseSha ? `${baseSha}..HEAD` : 'HEAD~1..HEAD';

  // 2. Collect git diff patch (baseSha..HEAD or HEAD~1..HEAD preferred, fallback to --cached, then unstaged)
  if (gitPath) {
    try {
      const diffStdout = execFileSync('git', ['diff', diffRange, '--'], {
        cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024,
      });
      evidence.implementation_diff_patch = diffStdout || null;
    } catch {
      // Try full diff if no parent commit
      try {
        const diffStdout = execFileSync('git', ['diff', '--cached', '--'], {
          cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024,
        });
        evidence.implementation_diff_patch = diffStdout || null;
      } catch {
        // Last resort: unstaged diff
        try {
          const diffStdout = execFileSync('git', ['diff', '--'], {
            cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 5 * 1024 * 1024,
          });
          evidence.implementation_diff_patch = diffStdout || null;
        } catch {}
      }
    }
  }

  // 3. Collect git diff stat
  if (gitPath) {
    try {
      const diffStatStdout = execFileSync('git', ['diff', diffRange, '--stat'], {
        cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      evidence.diff_stat = diffStatStdout || null;
    } catch {
      try {
        const diffStatStdout = execFileSync('git', ['diff', '--cached', '--stat'], {
          cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
        });
        evidence.diff_stat = diffStatStdout || null;
      } catch {}
    }
  }

  // 4. Collect changed files list from git
  if (gitPath) {
    try {
      const filesStdout = execFileSync('git', ['diff', diffRange, '--name-only'], {
        cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      evidence.changed_files = filesStdout ? filesStdout.trim().split('\n').filter(Boolean) : [];
    } catch {
      try {
        const filesStdout = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: gitPath, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
        });
        evidence.changed_files = filesStdout ? filesStdout.trim().split('\n').filter(Boolean) : [];
      } catch {}
    }
  }

  // 5. Read and parse result.json if available
  if (resultJsonPath) {
    try {
      await access(resultJsonPath, constants.F_OK);
      const raw = await readFile(resultJsonPath, 'utf8');
      evidence.result_json = JSON.parse(raw);
    } catch {
      evidence.result_json = null;
    }
  }

  // 6. Collect existing verification log if output dir already has one
  if (outputDir) {
    const logPath = join(outputDir, 'verification.log');
    try {
      await access(logPath, constants.F_OK);
      evidence.verification_log = await readFile(logPath, 'utf8');
      evidence.evidence_paths.verification_log = logPath;
    } catch {
      evidence.verification_log = null;
    }
  }

  // 7. Save evidence files
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });

    // 7a. Save implementation-diff.patch
    if (evidence.implementation_diff_patch) {
      const patchPath = join(outputDir, 'implementation-diff.patch');
      await writeFile(patchPath, evidence.implementation_diff_patch, 'utf8');
      evidence.evidence_paths.implementation_diff_patch = patchPath;
    }

    // 7b. Save verification.log (create if not present)
    const logPath = join(outputDir, 'verification.log');
    if (!evidence.verification_log) {
      const logContent = [
        `# Verification Evidence`,
        `# Generated: ${new Date().toISOString()}`,
        `# Git path: ${gitPath || 'N/A'}`,
        ``,
        `## Git Status`,
        evidence.git_status || '(clean or N/A)',
        ``,
        `## Diff Stat`,
        evidence.diff_stat || '(N/A)',
        ``,
        `## Changed Files`,
        ...(evidence.changed_files.length > 0 ? evidence.changed_files : ['(none)']),
        ``,
      ].join('\n');
      await writeFile(logPath, logContent, 'utf8');
      evidence.verification_log = logContent;
    }
    evidence.evidence_paths.verification_log = logPath;

    // 7c. Save acceptance.evidence.json
    const acceptanceEvidence = {
      collected_at: new Date().toISOString(),
      git_path: gitPath || null,
      git_status: evidence.git_status,
      diff_stat: evidence.diff_stat,
      changed_files: evidence.changed_files,
      implementation_diff_patch_path: evidence.evidence_paths.implementation_diff_patch || null,
      verification_log_path: evidence.evidence_paths.verification_log || null,
      result_json: evidence.result_json,
      acceptance_findings: Array.isArray(acceptanceFindings) ? acceptanceFindings : [],
    };
    const evidenceJsonPath = join(outputDir, 'acceptance.evidence.json');
    await writeFile(evidenceJsonPath, JSON.stringify(acceptanceEvidence, null, 2) + '\n', 'utf8');
    evidence.acceptance_evidence_json = evidenceJsonPath;
    evidence.evidence_paths.acceptance_evidence_json = evidenceJsonPath;
  }

  return evidence;
}

/**
 * Quick verification check — runs git status on a path to see if it's clean.
 *
 * @param {string} repoPath - Path to check
 * @returns {{ isClean: boolean, dirtyFiles: string[], error: string|null }}
 */
export function quickGitStatus(repoPath) {
  if (!repoPath) return { isClean: true, dirtyFiles: [], error: 'No path provided' };
  try {
    const stdout = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    const dirty = stdout.trim().split('\n').filter(Boolean);
    return { isClean: dirty.length === 0, dirtyFiles: dirty, error: null };
  } catch (e) {
    return { isClean: true, dirtyFiles: [], error: e.message || String(e) };
  }
}
