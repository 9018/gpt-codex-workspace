import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { runLocalShell } from "./local-shell-runner.mjs";

import { classifyCanonicalDirty, classifyFFOnlyFailure, recoverCanonicalDirty, recoverFFOnlyMerge } from './canonical-recovery.mjs';

const RECOVERY_FINDING_CODES = new Set([
  "commit_missing",
  "dirty_worktree_after_codex",
  "result_missing",
  "codex_failed",
]);

const EMPTY_COMMIT_VALUES = new Set(["", "none", "null", "undefined"]);

function nowMs() {
  return Date.now();
}

function tail(value, max = 4000) {
  return typeof value === "string" ? value.slice(-max) : "";
}

function normalizeCommit(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return EMPTY_COMMIT_VALUES.has(text.toLowerCase()) ? null : text;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function findingCodes(taskResult = {}, parsedResult = {}) {
  const all = [];
  for (const item of [taskResult, parsedResult]) {
    for (const finding of item?.acceptance_findings || []) {
      if (finding?.code) all.push(String(finding.code));
    }
    for (const code of item?.diagnosis_codes || []) all.push(String(code));
    if (item?.failure_class) all.push(String(item.failure_class));
    if (item?.kind) all.push(String(item.kind));
  }
  return uniqueStrings(all);
}

function initialEvidence({ task, taskResult, parsedResult, resolvedRepo, cr } = {}) {
  const started = nowMs();
  return {
    attempted: true,
    eligible: false,
    recovered: false,
    reason: "not_evaluated",
    task_id: task?.id || null,
    goal_id: null,
    worktree_path: resolvedRepo?.task_worktree_path || null,
    canonical_repo_path: resolvedRepo?.canonical_repo_path || null,
    changed_files: uniqueStrings([
      ...(Array.isArray(taskResult?.changed_files) ? taskResult.changed_files : []),
      ...(Array.isArray(parsedResult?.changed_files) ? parsedResult.changed_files : []),
    ]),
    commit: normalizeCommit(taskResult?.commit || parsedResult?.commit),
    local_head: null,
    remote_head: null,
    canonical_clean_before: null,
    canonical_clean_after: null,
    commands: [],
    verification: { passed: false, commands: [] },
    post_integration_verification: { passed: false, commands: [] },
    integration: { mode: "ff_only", merged: false },
    warnings: [],
    blockers: [],
    triggers: [],
    codex_exit_code: cr?.returncode ?? null,
    duration_ms: 0,
    _started: started,
  };
}

function finishEvidence(evidence, updates = {}) {
  const next = { ...evidence, ...updates };
  next.duration_ms = nowMs() - (evidence._started || nowMs());
  delete next._started;
  return next;
}

function addBlocker(evidence, code, message) {
  evidence.blockers.push({ code, message });
  if (evidence.reason === "not_evaluated" || evidence.eligible) evidence.reason = code;
}

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

function isClean(repoPath) {
  return git(repoPath, ["status", "--porcelain"]) === "";
}

function parseStatusFiles(statusText) {
  const files = [];
  for (const line of String(statusText || "").split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(2).trim();
    if (!raw) continue;
    const renameParts = raw.split(" -> ");
    files.push(renameParts[renameParts.length - 1]);
  }
  return uniqueStrings(files);
}

function collectChangedFiles(worktreePath, existing = []) {
  const statusFiles = parseStatusFiles(safeGit(worktreePath, ["status", "--porcelain"], ""));
  return uniqueStrings([...existing, ...statusFiles]);
}

function hasRecoverableFile(files = []) {
  const ignored = new Set(["result.json", "result.md", "verification.json"]);
  return files.some((file) => {
    const lower = file.toLowerCase();
    if (ignored.has(lower.split("/").pop())) return false;
    if (lower.startsWith(".gptwork/goals/") || lower.includes("/.gptwork/goals/")) return false;
    if (lower.startsWith(".git/")) return false;
    return /(^|\/)(src|test|tests|scripts|backend|frontend|docs|config|lib|bin|packages|app|public)\//.test(lower)
      || /\.(mjs|js|cjs|ts|tsx|jsx|json|md|yml|yaml|toml|lock|css|html|sh|sql|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp)$/.test(lower)
      || ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "dockerfile", "makefile"].includes(lower);
  });
}

function selectRecoveryCommands(config = {}, explicitCommands = null) {
  if (Array.isArray(explicitCommands)) return explicitCommands;
  if (Array.isArray(config.deliveryResultRecoveryCommands) && config.deliveryResultRecoveryCommands.length > 0) return config.deliveryResultRecoveryCommands;
  if (Array.isArray(config.resultRecoveryVerificationCommands) && config.resultRecoveryVerificationCommands.length > 0) return config.resultRecoveryVerificationCommands;
  if (Array.isArray(config.integrationCheckCommands) && config.integrationCheckCommands.length > 0) return config.integrationCheckCommands;
  return [
    "cd backend && npm run check:syntax",
    "cd backend && npm run check:imports",
    "cd backend && node scripts/release-delivery-check.mjs --fast",
  ];
}

async function runCommandEvidence({ cmd, cwd, timeoutSeconds, maxOutputBytes, runCommandFn }) {
  const started = nowMs();
  let result;
  try {
    result = await runCommandFn(cmd, cwd, timeoutSeconds, maxOutputBytes);
  } catch (error) {
    result = { returncode: 1, stdout: "", stderr: error?.message || String(error) };
  }
  return {
    cmd,
    cwd,
    exit_code: result?.returncode ?? result?.exit_code ?? 1,
    duration_ms: result?.duration_ms ?? (nowMs() - started),
    stdout_tail: tail(result?.stdout),
    stderr_tail: tail(result?.stderr),
  };
}

async function runCommandList({ commands, cwd, config, runCommandFn }) {
  const results = [];
  for (const cmd of commands) {
    const evidence = await runCommandEvidence({
      cmd,
      cwd,
      timeoutSeconds: config.resultRecoveryCommandTimeout || config.shellTimeout || 600,
      maxOutputBytes: config.maxShellOutputBytes || config.maxOutputBytes || 1_000_000,
      runCommandFn,
    });
    results.push(evidence);
    if (evidence.exit_code !== 0) break;
  }
  return { passed: results.length > 0 && results.every((command) => command.exit_code === 0), commands: results };
}

function normalizeTitle(title = "") {
  const text = String(title || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^a-zA-Z0-9._:/()\-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^P\d+(?:\.\d+)?\s*[:：\-]?\s*/i, "")
    .slice(0, 72)
    .trim();
  return text;
}

export function buildRecoveryCommitMessage(task = {}) {
  const normalized = normalizeTitle(task.title || task.id || "");
  const base = normalized ? `fix: auto recover ${normalized}` : "fix: recover codex delivery result";
  return base.replace(/[\r\n]+/g, " ").slice(0, 100).trim() || "fix: recover codex delivery result";
}

export function analyzeDeliveryRecoveryCandidate({ task, taskResult = {}, parsedResult = {}, resolvedRepo = {}, cr = null } = {}) {
  const evidence = initialEvidence({ task, taskResult, parsedResult, resolvedRepo, cr });
  const codes = findingCodes(taskResult, parsedResult);
  const resultChangedFiles = evidence.changed_files;
  const hasMissingCommitWithChangedFiles = resultChangedFiles.length > 0 && !normalizeCommit(taskResult.commit || parsedResult.commit);
  const isResultMissing = taskResult.failure_class === "result_missing" || parsedResult.failure_class === "result_missing";
  const isCodexFailed = taskResult.kind === "codex_failed" || parsedResult.kind === "codex_failed";

  const triggers = [];
  for (const code of codes) if (RECOVERY_FINDING_CODES.has(code)) triggers.push(code);
  if (hasMissingCommitWithChangedFiles) triggers.push("changed_files_without_commit");
  if (isResultMissing) triggers.push("result_missing");
  if (isCodexFailed) triggers.push("codex_failed");
  if (resolvedRepo?.task_worktree_path && existsSync(resolvedRepo.task_worktree_path)) {
    const dirtyFiles = collectChangedFiles(resolvedRepo.task_worktree_path, []);
    if (dirtyFiles.length > 0) {
      triggers.push("dirty_worktree_after_codex");
      evidence.changed_files = uniqueStrings([...evidence.changed_files, ...dirtyFiles]);
    }
  }
  evidence.triggers = uniqueStrings(triggers);

  if (resolvedRepo?.worktree_lifecycle?.mode !== "git_worktree" || resolvedRepo?.worktree_lifecycle?.ok !== true) {
    addBlocker(evidence, "not_git_worktree", "Delivery recovery requires an active git worktree task.");
  }
  if (!resolvedRepo?.task_worktree_path || !existsSync(resolvedRepo.task_worktree_path)) {
    addBlocker(evidence, "worktree_missing", "Task worktree path is missing or unavailable.");
  }
  if (!resolvedRepo?.canonical_repo_path || !existsSync(resolvedRepo.canonical_repo_path)) {
    addBlocker(evidence, "canonical_missing", "Canonical repository path is missing or unavailable.");
  }
  if (evidence.triggers.length === 0) {
    addBlocker(evidence, "no_recovery_trigger", "No delivery recovery trigger was detected.");
  }

  if (evidence.blockers.length === 0) {
    evidence.eligible = true;
    evidence.reason = "candidate";
  }
  return finishEvidence(evidence);
}

export async function runDeliveryRecovery({
  task,
  goal,
  config = {},
  resolvedRepo = {},
  taskResult = {},
  parsedResult = {},
  cr = null,
  verificationCommands = null,
  runCommandFn = runLocalShell,
} = {}) {
  const evidence = initialEvidence({ task, taskResult, parsedResult, resolvedRepo, cr });
  evidence.goal_id = goal?.id || null;
  const candidate = analyzeDeliveryRecoveryCandidate({ task, taskResult, parsedResult, resolvedRepo, cr });
  evidence.triggers = candidate.triggers || [];
  evidence.blockers = [...candidate.blockers];
  evidence.eligible = candidate.eligible;
  evidence.reason = candidate.reason;

  const worktreePath = resolvedRepo.task_worktree_path;
  const canonicalRepoPath = resolvedRepo.canonical_repo_path;
  if (!candidate.eligible) return finishEvidence(evidence);

  try {
    evidence.local_head = safeGit(worktreePath, ["rev-parse", "HEAD"]);
    evidence.remote_head = safeGit(canonicalRepoPath, ["rev-parse", `origin/${config.defaultBranch || "main"}`]);
    evidence.canonical_clean_before = isClean(canonicalRepoPath);
    if (!evidence.canonical_clean_before) {
      // Classify canonical dirtiness and attempt safe recovery
      const dirtyClassification = classifyCanonicalDirty(canonicalRepoPath);
      evidence.canonical_dirty_classification = dirtyClassification;

      if (dirtyClassification.is_safe_to_clean) {
        const recoveryResult = recoverCanonicalDirty(canonicalRepoPath, dirtyClassification);
        evidence.canonical_dirty_recovery = recoveryResult;

        if (!recoveryResult.clean_after) {
          addBlocker(evidence, "canonical_dirty", recoveryResult.reason || "Canonical repository could not be cleaned.");
          evidence.eligible = false;
          return finishEvidence(evidence);
        }
        // Recovery cleaned safe files — proceed
      } else {
        addBlocker(evidence, "canonical_dirty", dirtyClassification.recommendation === "human_interrupt_required"
          ? "Canonical repository has unexpected source mutations. Human interrupt required. Evidence: " + JSON.stringify(dirtyClassification.by_source)
          : "Canonical repository is dirty before recovery.");
        evidence.eligible = false;
        return finishEvidence(evidence);
      }
    }

    evidence.changed_files = collectChangedFiles(worktreePath, evidence.changed_files);
    if (evidence.changed_files.length === 0) {
      // P0-MA11-R1: Check if the task commit is already integrated before
      // declaring no_changed_files.  A clean worktree with a commit already
      // on the canonical branch is a completed delivery, not a failure.
      const taskCommit = normalizeCommit(taskResult.commit || parsedResult.commit);
      if (taskCommit) {
        const canonicalHead = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
        if (canonicalHead) {
          let commitIsIntegrated = canonicalHead === taskCommit;
          if (!commitIsIntegrated) {
            try {
              git(canonicalRepoPath, ["merge-base", "--is-ancestor", taskCommit, canonicalHead]);
              commitIsIntegrated = true;
            } catch (_mergeBaseErr) {
              // not an ancestor -- stay false
            }
          }
          if (commitIsIntegrated) {
            const canonicalClean = isClean(canonicalRepoPath);
            evidence.recovered = true;
            evidence.eligible = true;
            evidence.commit_integrated = true;
            evidence.commit = taskCommit;
            evidence.local_head = canonicalHead;
            evidence.remote_head = canonicalHead;
            evidence.canonical_clean = canonicalClean;
            evidence.canonical_clean_before = canonicalClean;
            evidence.canonical_clean_after = canonicalClean;
            evidence.reason = "already_integrated";
            evidence.verification = { passed: true, commands: [] };
            evidence.tests = taskResult.tests || "already integrated (no staged changes needed)";
            evidence.warnings.push(`No changed files in worktree: commit ${taskCommit.slice(0, 7)} already integrated in canonical repo.`);
            return finishEvidence(evidence);
          }
        }
      }
      addBlocker(evidence, "no_changed_files", "Task worktree has no changed files to recover.");
      evidence.eligible = false;
      return finishEvidence(evidence);
    }
    if (!hasRecoverableFile(evidence.changed_files)) {
      addBlocker(evidence, "no_recoverable_files", "Task worktree changes do not include code, config, tests, or docs files.");
      evidence.eligible = false;
      return finishEvidence(evidence);
    }

    let diffCheck;
    try {
      git(worktreePath, ["diff", "--check"]);
      diffCheck = { cmd: "git diff --check", cwd: worktreePath, exit_code: 0, duration_ms: 0, stdout_tail: "", stderr_tail: "" };
    } catch (error) {
      diffCheck = { cmd: "git diff --check", cwd: worktreePath, exit_code: error.status || 1, duration_ms: 0, stdout_tail: tail(error.stdout?.toString?.()), stderr_tail: tail(error.stderr?.toString?.() || error.message) };
    }
    evidence.commands.push(diffCheck);
    if (diffCheck.exit_code !== 0) {
      addBlocker(evidence, "diff_check_failed", "git diff --check failed.");
      evidence.verification = { passed: false, commands: [diffCheck] };
      return finishEvidence(evidence);
    }

    const commands = selectRecoveryCommands(config, verificationCommands);
    const verification = await runCommandList({ commands, cwd: worktreePath, config, runCommandFn });
    evidence.verification = verification;
    evidence.commands.push(...verification.commands);
    if (!verification.passed) {
      addBlocker(evidence, "verification_failed", "Delivery recovery verification command failed.");
      return finishEvidence(evidence);
    }

    git(worktreePath, ["add", "--all"]);
    const staged = git(worktreePath, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) {
      // P0-MA11-R1: Already-integrated check for the empty_commit path.
      // git add --all may produce no staged changes when the worktree is
      // clean and the commit is already part of the canonical branch.
      const taskCommit = normalizeCommit(taskResult.commit || parsedResult.commit);
      if (taskCommit) {
        const canonicalHead = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
        if (canonicalHead) {
          let commitIsIntegrated = canonicalHead === taskCommit;
          if (!commitIsIntegrated) {
            try {
              git(canonicalRepoPath, ["merge-base", "--is-ancestor", taskCommit, canonicalHead]);
              commitIsIntegrated = true;
            } catch (_mergeBaseErr) {
              // not an ancestor -- stay false
            }
          }
          if (commitIsIntegrated) {
            const canonicalClean = isClean(canonicalRepoPath);
            evidence.recovered = true;
            evidence.eligible = true;
            evidence.commit_integrated = true;
            evidence.commit = taskCommit;
            evidence.local_head = canonicalHead;
            evidence.remote_head = canonicalHead;
            evidence.canonical_clean = canonicalClean;
            evidence.canonical_clean_before = canonicalClean;
            evidence.canonical_clean_after = canonicalClean;
            evidence.integration = { mode: "ff_only", merged: true, status: "already_integrated", commit: taskCommit };
            evidence.reason = "already_integrated";
            evidence.verification = { passed: true, commands: evidence.commands || [] };
            evidence.tests = taskResult.tests || "already integrated (no staged changes needed)";
            evidence.warnings.push(`No staged changes in worktree: commit ${taskCommit.slice(0, 7)} already integrated in canonical repo.`);
            return finishEvidence(evidence);
          }
        }
      }
      addBlocker(evidence, "empty_commit", "No staged changes were available for recovery commit.");
      return finishEvidence(evidence);
    }
    const message = buildRecoveryCommitMessage(task);
    git(worktreePath, ["commit", "-m", message]);
    evidence.commit = git(worktreePath, ["rev-parse", "HEAD"]);
    evidence.local_head = evidence.commit;

    try {
      git(canonicalRepoPath, ["merge", "--ff-only", evidence.commit]);
      evidence.integration = { mode: "ff_only", merged: true, status: "merged", commit: evidence.commit };
    } catch (error) {
      evidence.integration = { mode: "ff_only", merged: false, status: "ff_only_failed", error: tail(error.stderr?.toString?.() || error.message, 1000) };

      // Classify ff-only failure and attempt recovery
      const ffClassification = classifyFFOnlyFailure(canonicalRepoPath, worktreePath, evidence.commit);
      evidence.ff_only_failure_classification = ffClassification;

      if (ffClassification.is_recoverable) {
        const recoveryResult = await recoverFFOnlyMerge({
          canonicalRepoPath,
          worktreePath,
          failureClassification: ffClassification,
          defaultBranch: config.defaultBranch || "main",
        });
        evidence.ff_only_recovery_result = recoveryResult;

        if (recoveryResult.outcome && recoveryResult.outcome.startsWith("recovered")) {
          evidence.integration = {
            mode: "ff_only",
            merged: true,
            status: recoveryResult.outcome,
            commit: recoveryResult.recovered_commit || evidence.commit,
          };
          evidence.remote_head = recoveryResult.head_after;
        } else {
          addBlocker(evidence, "ff_only_merge_failed", "Recovery failed: " + (recoveryResult.reason || "Could not fast-forward merge."));
          evidence.ff_only_failure_evidence = recoveryResult.evidence || {};
          return finishEvidence(evidence);
        }
      } else {
        addBlocker(evidence, "ff_only_merge_failed", ffClassification.divergence_detail || "Could not fast-forward merge.");
        evidence.ff_only_failure_evidence = { canonical_head: ffClassification.canonical_head, target_commit: ffClassification.target_commit, merge_base: ffClassification.merge_base, failure_reason: ffClassification.failure_reason };
        return finishEvidence(evidence);
      }
    }

    evidence.canonical_clean_after = isClean(canonicalRepoPath);
    if (!evidence.canonical_clean_after) {
      addBlocker(evidence, "canonical_dirty_after_merge", "Canonical repository is dirty after fast-forward merge.");
      return finishEvidence(evidence);
    }

    const postVerification = await runCommandList({ commands, cwd: canonicalRepoPath, config, runCommandFn });
    evidence.post_integration_verification = postVerification;
    evidence.commands.push(...postVerification.commands);
    if (!postVerification.passed) {
      addBlocker(evidence, "post_integration_verification_failed", "Canonical fast gate failed after recovery merge.");
      return finishEvidence(evidence);
    }

    evidence.remote_head = evidence.remote_head || safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]);
    evidence.recovered = true;
    evidence.eligible = true;
    evidence.reason = "recovered_dirty_worktree_delivery";
    evidence.commit_integrated = true;
    evidence.canonical_clean = evidence.canonical_clean_after === true;
    evidence.local_head = safeGit(canonicalRepoPath, ["rev-parse", "HEAD"]) || evidence.commit;
    evidence.remote_head = evidence.remote_head || evidence.local_head;
    evidence.tests = `${verification.commands.length + postVerification.commands.length} delivery recovery verification command(s) passed`;
    return finishEvidence(evidence);
  } catch (error) {
    addBlocker(evidence, "recovery_error", error?.message || String(error));
    return finishEvidence(evidence);
  }
}
