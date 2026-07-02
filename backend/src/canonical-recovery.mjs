/**
 * canonical-recovery.mjs — Classified integration recovery paths
 *
 * Turns canonical_dirty and ff_only_merge_failed from generic blockers
 * into classified integration recovery paths with evidence capture
 * and safe recovery mechanisms.
 *
 * ## canonical_dirty classification
 *
 *   - generated/temp            Build artifacts, caches, temp files
 *   - expected_integration_artifact  result.json, lockfiles, diagnostic outputs
 *   - unexpected_source_mutation     Source/test/config changes not attributable
 *                                    to the integration flow
 *   - unknown                       Cannot classify reliably
 *
 * ## ff_only_merge_failed classification
 *
 *   - canonical_advanced  Canonical HEAD has new commits not in the worktree
 *   - worktree_diverged   Both sides diverged from a common ancestor
 *   - merge_conflict      Dry-run merge produced a conflict
 *   - unknown             Could not determine the divergence cause
 *
 * ## Diagnostic contract
 *
 *   Every classification and recovery call records:
 *   - canonical HEAD before and after
 *   - whether the repo is clean after recovery
 *   - recovery attempt count and outcome
 *   - Never silently discards user/source changes
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Internal git helpers
// ---------------------------------------------------------------------------

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout || 60_000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
  }).trim();
}

function safeGit(cwd, args, fallback = null) {
  try {
    return git(cwd, args);
  } catch {
    return fallback;
  }
}

function nowISO() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Dirty path classification patterns
// ---------------------------------------------------------------------------

/**
 * Patterns matching build artifacts, caches, and editor/system temp files.
 */
const GENERATED_TEMP_PATTERNS = [
  /\.(tmp|log|pid|lock|swp|swo|bak|orig)\b/i,
  /__pycache__/,
  /node_modules(\/|$)/,
  /\.npm(\/|$)/,
  /\.next(\/|$)/,
  /\.turbo(\/|$)/,
  /dist(\/|$)/,
  /build(\/|$)/,
  /\.cache(\/|$)/,
  /coverage(\/|$)/,
  /\.nyc_output(\/|$)/,
  /\.eslintcache/,
  /\.stylelintcache/,
  /\bTAGS\b/,
  /\.DS_Store/,
  /Thumbs\.db/,
];

/**
 * Patterns matching files the integration flow routinely produces.
 */
const EXPECTED_INTEGRATION_ARTIFACT_PATTERNS = [
  /result\.json$/,
  /result\.md$/,
  /verification\.json$/,
  /acceptance\.evidence\.json$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /go\.sum$/,
  /Cargo\.lock$/,
];

// ---------------------------------------------------------------------------
// Public classification constants
// ---------------------------------------------------------------------------

export const DIRTY_CLASSIFICATION = Object.freeze({
  GENERATED_TEMP: "generated/temp",
  EXPECTED_INTEGRATION_ARTIFACT: "expected_integration_artifact",
  UNEXPECTED_SOURCE_MUTATION: "unexpected_source_mutation",
  UNKNOWN: "unknown",
  CLEAN: "clean",
});

export const FF_ONLY_FAILURE_CLASSIFICATION = Object.freeze({
  CANONICAL_ADVANCED: "canonical_advanced",
  WORKTREE_DIVERGED: "worktree_diverged",
  MERGE_CONFLICT: "merge_conflict",
  UNKNOWN: "unknown",
});

// ---------------------------------------------------------------------------
// File-level classification
// ---------------------------------------------------------------------------

/**
 * Classify a single relative path into a dirty-source category.
 *
 * @param {string} relPath — Repository-relative file path
 * @returns {string} One of DIRTY_CLASSIFICATION values
 */
export function classifyDirtyPath(relPath) {
  for (const pattern of GENERATED_TEMP_PATTERNS) {
    if (pattern.test(relPath)) return DIRTY_CLASSIFICATION.GENERATED_TEMP;
  }
  for (const pattern of EXPECTED_INTEGRATION_ARTIFACT_PATTERNS) {
    if (pattern.test(relPath)) return DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT;
  }
  // Heuristic: paths that look like tracked source code
  if (
    /^(src|backend\/src|test|tests|docs|config|scripts|lib|bin|packages|app|public)\//.test(relPath) ||
    /\.(mjs|js|cjs|ts|tsx|jsx|py|rs|go|rb|java|kt|swift|sh|sql|css|html|vue|svelte)$/.test(relPath) ||
    /^(package\.json|dockerfile|makefile|\.editorconfig|\.gitignore)$/i.test(relPath)
  ) {
    return DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION;
  }
  return DIRTY_CLASSIFICATION.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Parse `git status --porcelain` output
// ---------------------------------------------------------------------------

function parseStatusEntries(statusText) {
  const entries = [];
  for (const line of String(statusText || "").split("\n")) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const raw = line.slice(2).trim();
    if (!raw) continue;
    const renameParts = raw.split(" -> ");
    const path = renameParts[renameParts.length - 1];
    entries.push({ path, xy, is_untracked: xy === "??" || xy[1] === "?" });
  }
  return entries;
}

function parseStatusFiles(statusText) {
  return parseStatusEntries(statusText).map(e => e.path);
}

// ---------------------------------------------------------------------------
// 1. Canonical dirty classification
// ---------------------------------------------------------------------------

/**
 * Classify and diagnose canonical dirty state.
 *
 * Captures:
 * - dirty paths and full git status snapshot
 * - per-file classification
 * - overall classification
 * - head SHA before classification
 *
 * @param {string} repoPath — Canonical repository path
 * @returns {object} Classification result
 */
export function classifyCanonicalDirty(repoPath) {
  const headBefore = safeGit(repoPath, ["rev-parse", "HEAD"]);
  const statusText = safeGit(repoPath, ["status", "--porcelain"], "");
  const diffStat = safeGit(repoPath, ["diff", "--stat"], "");
  const statusEntries = parseStatusEntries(statusText);
  const dirtyPaths = parseStatusFiles(statusText);

  const classifiedFiles = statusEntries.map((entry) => ({
    path: entry.path,
    is_untracked: entry.is_untracked,
    classification: classifyDirtyPath(entry.path),
  }));

  const categories = {};
  for (const { classification } of classifiedFiles) {
    categories[classification] = (categories[classification] || 0) + 1;
  }

  const bySource = {};
  for (const cf of classifiedFiles) {
    const c = cf.classification;
    if (!bySource[c]) bySource[c] = [];
    bySource[c].push(cf.path);
  }

  // Determine overall classification (most severe wins)
  let overallClassification = DIRTY_CLASSIFICATION.CLEAN;
  if (classifiedFiles.length > 0) {
    if (classifiedFiles.some((cf) => cf.classification === DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION)) {
      overallClassification = DIRTY_CLASSIFICATION.UNEXPECTED_SOURCE_MUTATION;
    } else if (classifiedFiles.some((cf) => cf.classification === DIRTY_CLASSIFICATION.UNKNOWN)) {
      overallClassification = DIRTY_CLASSIFICATION.UNKNOWN;
    } else if (classifiedFiles.every((cf) => cf.classification === DIRTY_CLASSIFICATION.GENERATED_TEMP)) {
      overallClassification = DIRTY_CLASSIFICATION.GENERATED_TEMP;
    } else {
      overallClassification = DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT;
    }
  }

  const isSafeToClean =
    overallClassification === DIRTY_CLASSIFICATION.GENERATED_TEMP ||
    overallClassification === DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT;

  return {
    timestamp: nowISO(),
    head_before: headBefore,
    is_dirty: dirtyPaths.length > 0,
    dirty_paths: dirtyPaths,
    status_snapshot: statusText,
    diff_stat: diffStat,
    file_count: classifiedFiles.length,
    classified_files: classifiedFiles,
    categories,
    by_source: bySource,
    overall_classification: overallClassification,
    is_safe_to_clean: isSafeToClean,
    recommendation: isSafeToClean
      ? "safe_clean_or_reset"
      : "human_interrupt_required",
    recovery_attempts: 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Canonical dirty recovery
// ---------------------------------------------------------------------------

/**
 * Safely clean or reset dirtiness that is classified as
 * `generated/temp` or `expected_integration_artifact`.
 *
 * Never silently discards files classified as `unexpected_source_mutation`
 * or `unknown`.
 *
 * @param {string} repoPath — Canonical repository path
 * @param {object} classification — Result from classifyCanonicalDirty()
 * @returns {object} Recovery result with diagnostic evidence
 */
export function recoverCanonicalDirty(repoPath, classification) {
  const beforeHead = safeGit(repoPath, ["rev-parse", "HEAD"]);
  const startMs = Date.now();

  // Nothing to do
  if (!classification.is_dirty) {
    return {
      timestamp: nowISO(),
      recovery_attempted: false,
      recovery_needed: false,
      head_before: beforeHead,
      head_after: beforeHead,
      clean_after: true,
      outcome: "noop_clean",
      reason: "Canonical repository was already clean.",
      actions: [],
      elapsed_ms: Date.now() - startMs,
    };
  }

  // Not safe to auto-clean — emit typed interrupt evidence
  if (!classification.is_safe_to_clean) {
    return {
      timestamp: nowISO(),
      recovery_attempted: false,
      recovery_needed: true,
      head_before: beforeHead,
      head_after: beforeHead,
      clean_after: false,
      outcome: "blocked_unsafe",
      reason: `Cannot auto-clean: dirty source classified as "${classification.overall_classification}". Human interrupt required.`,
      classification: classification.overall_classification,
      evidence: {
        dirty_files: classification.dirty_paths,
        by_source: classification.by_source,
        diff_stat: classification.diff_stat,
        status_snapshot: classification.status_snapshot,
      },
      actions: [],
      elapsed_ms: Date.now() - startMs,
    };
  }

  // Defensive: verify no unexpected files leaked into the safe set
  const unknownInSafeSet = classification.classified_files.filter(
    (cf) =>
      cf.classification !== DIRTY_CLASSIFICATION.GENERATED_TEMP &&
      cf.classification !== DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT
  );
  if (unknownInSafeSet.length > 0) {
    return {
      timestamp: nowISO(),
      recovery_attempted: false,
      recovery_needed: true,
      head_before: beforeHead,
      head_after: beforeHead,
      clean_after: false,
      outcome: "blocked_unsafe_misclassified",
      reason: `Defensive block: ${unknownInSafeSet.length} file(s) classified as "${unknownInSafeSet[0].classification}" found in what was thought to be a safe-only set.`,
      evidence: { files: unknownInSafeSet.map((cf) => cf.path) },
      actions: [],
      elapsed_ms: Date.now() - startMs,
    };
  }

  // Perform clean
  const actions = [];
  const safePaths = classification.classified_files
    .filter(
      (cf) =>
        cf.classification === DIRTY_CLASSIFICATION.GENERATED_TEMP ||
        cf.classification === DIRTY_CLASSIFICATION.EXPECTED_INTEGRATION_ARTIFACT
    )
    .map((cf) => cf.path);

  // Build a lookup for status info
  const statusLookup = {};
  for (const entry of classification.classified_files || []) {
    statusLookup[entry.path] = entry;
  }

  for (const filePath of safePaths) {
    try {
      const entry = statusLookup[filePath] || {};
      const isUntracked = entry.is_untracked === true;
      const fullPath = join(repoPath, filePath);
      if (!existsSync(fullPath)) {
        actions.push({ file: filePath, action: "skipped_not_found", classification: classifyDirtyPath(filePath) });
        continue;
      }
      const isDir = statSync(fullPath).isDirectory();
      if (isDir) {
        git(repoPath, ["clean", "-fd", "--", filePath]);
        actions.push({ file: filePath, action: "git_clean_-fd", classification: classifyDirtyPath(filePath) });
      } else if (isUntracked) {
        // Untracked files: use git clean -f for safety
        git(repoPath, ["clean", "-f", "--", filePath]);
        actions.push({ file: filePath, action: "git_clean_-f", classification: classifyDirtyPath(filePath) });
      } else {
        git(repoPath, ["checkout", "--", filePath]);
        actions.push({ file: filePath, action: "git_checkout", classification: classifyDirtyPath(filePath) });
      }
    } catch (err) {
      actions.push({ file: filePath, action: "failed", error: err.message, classification: classifyDirtyPath(filePath) });
    }
  }

  // Final clean sweep for any remaining untracked generated files
  // (but never nuke result.json)
  safeGit(repoPath, ["clean", "-fd", "-e", "result.json"]);

  const headAfter = safeGit(repoPath, ["rev-parse", "HEAD"]);
  const cleanAfter = safeGit(repoPath, ["status", "--porcelain"]) === "";

  return {
    timestamp: nowISO(),
    recovery_attempted: true,
    recovery_needed: true,
    head_before: beforeHead,
    head_after: headAfter,
    clean_after: cleanAfter,
    outcome: cleanAfter ? "cleaned_safe_only" : "partial_clean",
    reason: cleanAfter
      ? `Recovered by cleaning ${safePaths.length} safe file(s).`
      : `Partially cleaned ${safePaths.length} file(s); remaining unstaged changes require attention.`,
    classification: classification.overall_classification,
    cleaned_files: safePaths,
    actions,
    elapsed_ms: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// 3. FF-only failure classification
// ---------------------------------------------------------------------------

/**
 * Classify why an ff-only merge failed between canonical repo and a commit.
 *
 * Detection logic:
 *   1. Compute merge-base between canonical HEAD and the target commit.
 *   2. Count commits reachable from each side but not the merge-base.
 *   3. Attempt a dry-run merge to detect potential conflicts.
 *   4. Map the result to a failure reason.
 *
 * @param {string} canonicalRepoPath — Canonical repository path
 * @param {string} worktreePath — Worktree path (for commit log queries)
 * @param {string} commit — The commit SHA that could not be merged
 * @returns {object} Classification result
 */
export function classifyFFOnlyFailure(canonicalRepoPath, worktreePath, commit) {
  const canonicalHead = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
  const canonicalHeadMsg = safeGit(canonicalRepoPath, ["log", "--oneline", "-1", "HEAD"], "");

  // Merge-base analysis
  let mergeBase = null;
  let canonicalCommitsAhead = 0;
  let commitCommitsAhead = 0;

  try {
    mergeBase = git(canonicalRepoPath, ["merge-base", canonicalHead, commit]);
    const canonicalLog = safeGit(canonicalRepoPath, ["log", "--oneline", canonicalHead, "--not", mergeBase], "");
    const commitLog = safeGit(worktreePath || canonicalRepoPath, ["log", "--oneline", commit, "--not", mergeBase], "");
    canonicalCommitsAhead = canonicalLog ? canonicalLog.split("\n").filter(Boolean).length : 0;
    commitCommitsAhead = commitLog ? commitLog.split("\n").filter(Boolean).length : 0;
  } catch {
    // merge-base itself failed — treat as unknown
    mergeBase = null;
  }

  let failureReason;
  let divergenceDetail;

  if (mergeBase === null) {
    failureReason = FF_ONLY_FAILURE_CLASSIFICATION.UNKNOWN;
    divergenceDetail = "Could not compute a merge-base between canonical HEAD and target commit. Possible object corruption or independent history.";
  } else if (canonicalCommitsAhead > 0 && commitCommitsAhead === 0) {
    failureReason = FF_ONLY_FAILURE_CLASSIFICATION.CANONICAL_ADVANCED;
    divergenceDetail = `Canonical is ${canonicalCommitsAhead} commit(s) ahead of the worktree commit; fast-forward would require rebasing the worktree first.`;
  } else if (canonicalCommitsAhead > 0 && commitCommitsAhead > 0) {
    failureReason = FF_ONLY_FAILURE_CLASSIFICATION.WORKTREE_DIVERGED;
    divergenceDetail = `Both sides diverged: canonical ${canonicalCommitsAhead} ahead, worktree ${commitCommitsAhead} ahead of merge-base. Simple rebase may not suffice.`;
  } else if (canonicalCommitsAhead === 0 && commitCommitsAhead > 0) {
    failureReason = FF_ONLY_FAILURE_CLASSIFICATION.UNKNOWN;
    divergenceDetail = "Worktree commit is ahead of canonical HEAD yet ff-only still failed. Possible object corruption or history mismatch.";
  } else {
    failureReason = FF_ONLY_FAILURE_CLASSIFICATION.UNKNOWN;
    divergenceDetail = "No divergence detected via merge-base. Possible corruption or identical commits with different SHAs.";
  }

  // Merge-conflict dry run (clean up regardless of outcome)
  let mergeConflictDetected = null;
  try {
    git(canonicalRepoPath, ["merge", "--no-commit", "--no-ff", commit], { timeout: 30_000 });
    git(canonicalRepoPath, ["merge", "--abort"]);
    mergeConflictDetected = false;
  } catch {
    mergeConflictDetected = true;
    safeGit(canonicalRepoPath, ["merge", "--abort"]);
  }

  const isRecoverable = 
    failureReason === FF_ONLY_FAILURE_CLASSIFICATION.CANONICAL_ADVANCED ||
    (failureReason === FF_ONLY_FAILURE_CLASSIFICATION.WORKTREE_DIVERGED && !mergeConflictDetected);

  return {
    timestamp: nowISO(),
    canonical_head: canonicalHead,
    canonical_head_message: canonicalHeadMsg,
    target_commit: commit,
    merge_base: mergeBase,
    failure_reason: failureReason,
    divergence_detail: divergenceDetail,
    canonical_commits_ahead: canonicalCommitsAhead,
    commit_commits_ahead: commitCommitsAhead,
    merge_conflict_detected: mergeConflictDetected,
    is_recoverable: isRecoverable,
    recommendation: isRecoverable
      ? "rebase_or_recreate_integration_branch"
      : failureReason === FF_ONLY_FAILURE_CLASSIFICATION.WORKTREE_DIVERGED
        ? "merge_conflict_recovery_interrupt"
        : "integration_recovery_interrupt",
  };
}

// ---------------------------------------------------------------------------
// 4. FF-only merge recovery
// ---------------------------------------------------------------------------

/**
 * Attempt safe recovery from an ff-only merge failure.
 *
 * Strategies (tried in order):
 *   1. Rebase worktree branch onto canonical HEAD, then retry ff-only.
 *   2. If rebase fails, create a temporary branch, cherry-pick the
 *      worktree commit, and ff-only merge that.
 *
 * If both fail, returns a typed failure evidence block suitable for
 * an integration recovery interrupt.
 *
 * @param {object} opts
 * @param {string} opts.canonicalRepoPath  — Canonical repository path
 * @param {string} opts.worktreePath       — Worktree path
 * @param {object} opts.failureClassification — Result from classifyFFOnlyFailure()
 * @param {string} [opts.defaultBranch="main"] — Branch name in canonical repo
 * @param {object} [opts.config={}]        — Optional config (unused but reserved)
 * @returns {Promise<object>} Recovery result
 */
export async function recoverFFOnlyMerge({
  canonicalRepoPath,
  worktreePath,
  failureClassification,
  defaultBranch = "main",
  config = {},
} = {}) {
  const headBefore = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
  const startMs = Date.now();
  const actions = [];

  // Not recoverable — emit typed interrupt evidence
  if (!failureClassification.is_recoverable) {
    return {
      timestamp: nowISO(),
      recovery_attempted: false,
      head_before: headBefore,
      head_after: headBefore,
      clean_after: safeGit(canonicalRepoPath, ["status", "--porcelain"]) === "",
      outcome: "blocked_unrecoverable",
      reason: failureClassification.divergence_detail,
      failure_reason: failureClassification.failure_reason,
      merge_conflict_detected: failureClassification.merge_conflict_detected,
      evidence: {
        canonical_head: failureClassification.canonical_head,
        target_commit: failureClassification.target_commit,
        merge_base: failureClassification.merge_base,
        divergence_detail: failureClassification.divergence_detail,
      },
      attempts: 0,
      actions: [],
      elapsed_ms: Date.now() - startMs,
    };
  }

  // ---- Strategy 1: Rebase worktree onto canonical HEAD ----
  // Works for both canonical_advanced and worktree_diverged (when no conflict)
  try {
    const branchName = safeGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";

    git(worktreePath, ["fetch", canonicalRepoPath, `refs/heads/${defaultBranch}`]);
    git(worktreePath, ["rebase", "FETCH_HEAD"]);
    actions.push({ action: "rebase", target: `FETCH_HEAD (${defaultBranch})`, result: "ok" });

    // Retry ff-only merge from canonical side
    const worktreeHead = git(worktreePath, ["rev-parse", "HEAD"]);
    git(canonicalRepoPath, ["merge", "--ff-only", worktreeHead]);
    actions.push({ action: "ff-only-merge", commit: worktreeHead, result: "ok" });

    const headAfter = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
    const cleanAfter = safeGit(canonicalRepoPath, ["status", "--porcelain"]) === "";

    return {
      timestamp: nowISO(),
      recovery_attempted: true,
      head_before: headBefore,
      head_after: headAfter,
      clean_after: cleanAfter,
      outcome: "recovered_via_rebase",
      reason: "Rebased worktree on canonical HEAD and retried ff-only merge.",
      failure_reason: failureClassification.failure_reason,
      recovered_commit: worktreeHead,
      attempts: 1,
      actions,
      elapsed_ms: Date.now() - startMs,
    };
  } catch (rebaseError) {
    actions.push({ action: "rebase", result: "failed", error: rebaseError.message });
  }

  // ---- Strategy 2: Cherry-pick worktree commit onto canonical HEAD ----
  try {
    const worktreeCommit = safeGit(worktreePath, ["rev-parse", "HEAD"]);
    const canonicalHead = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
    const cherryBranch = `recovery/cherry-${Date.now()}`;

    git(canonicalRepoPath, ["branch", cherryBranch, canonicalHead]);
    git(canonicalRepoPath, ["checkout", cherryBranch]);
    git(canonicalRepoPath, ["cherry-pick", worktreeCommit]);

    const cherryHead = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);

    // Return to default branch and ff-only merge
    git(canonicalRepoPath, ["checkout", defaultBranch]);
    git(canonicalRepoPath, ["merge", "--ff-only", cherryHead]);

    // Clean up temp branch
    safeGit(canonicalRepoPath, ["branch", "-D", cherryBranch]);

    actions.push({ action: "cherry-pick", branch: cherryBranch, result: "ok" });

    const headAfter = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
    const cleanAfter = safeGit(canonicalRepoPath, ["status", "--porcelain"]) === "";

    return {
      timestamp: nowISO(),
      recovery_attempted: true,
      head_before: headBefore,
      head_after: headAfter,
      clean_after: cleanAfter,
      outcome: "recovered_via_cherry_pick",
      reason: "Rebase failed; recovered via cherry-pick onto temporary integration branch.",
      failure_reason: failureClassification.failure_reason,
      recovered_commit: headAfter,
      attempts: 2,
      actions,
      elapsed_ms: Date.now() - startMs,
    };
  } catch (cherryError) {
    // Restore canonical to a clean state
    safeGit(canonicalRepoPath, ["checkout", defaultBranch]);
    safeGit(canonicalRepoPath, ["merge", "--abort"]);

    actions.push({ action: "cherry-pick", result: "failed", error: cherryError.message });

    return {
      timestamp: nowISO(),
      recovery_attempted: true,
      head_before: headBefore,
      head_after: safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]),
      clean_after: safeGit(canonicalRepoPath, ["status", "--porcelain"]) === "",
      outcome: "recovery_failed",
      reason: "Rebase and cherry-pick both failed. Human integration recovery interrupt required.",
      failure_reason: failureClassification.failure_reason,
      merge_conflict_detected: failureClassification.merge_conflict_detected,
      evidence: {
        canonical_head: failureClassification.canonical_head,
        target_commit: failureClassification.target_commit,
        merge_base: failureClassification.merge_base,
        rebase_error: rebaseError.message,
        cherry_pick_error: cherryError.message,
      },
      attempts: 2,
      actions,
      elapsed_ms: Date.now() - startMs,
    };
  }
}
