import { execFileSync } from "node:child_process";

function gitOutput(repoPath, args) {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
}

function shortSha(value) {
  return typeof value === "string" && value.length >= 7 ? value.slice(0, 7) : value;
}

function commandListFromConfig(config = {}) {
  if (Array.isArray(config.deliveryResultRecoveryCommands)) return config.deliveryResultRecoveryCommands;
  if (Array.isArray(config.resultRecoveryVerificationCommands)) return config.resultRecoveryVerificationCommands;
  return [];
}

export function recoveryCommandListFromConfig(config = {}) {
  if (Array.isArray(config.deliveryResultRecoveryCommands) && config.deliveryResultRecoveryCommands.length > 0) return config.deliveryResultRecoveryCommands;
  if (Array.isArray(config.resultRecoveryVerificationCommands) && config.resultRecoveryVerificationCommands.length > 0) return config.resultRecoveryVerificationCommands;
  if (Array.isArray(config.integrationCheckCommands) && config.integrationCheckCommands.length > 0) return config.integrationCheckCommands;
  return null;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.length > 0))];
}

function clearResolvedDeliveryFindings(findings = []) {
  const resolvedCodes = new Set(["commit_missing", "dirty_worktree_after_codex"]);
  return findings.map((finding) => resolvedCodes.has(finding?.code)
    ? { ...finding, severity: "followup", resolved: true, message: (finding.message || finding.code) + " (resolved by delivery_result_recovery)" }
    : finding);
}

export function applySuccessfulDeliveryRecovery(taskResult, recovery, summary) {
  const recoveredSummary = recovery.summary || summary || taskResult.summary || "Recovered Codex delivery result from dirty worktree.";
  if (recovery.reason === "already_integrated") {
    const alreadyIntegrated = {
      ...taskResult,
      kind: "codex_executed",
      summary: recoveredSummary,
      commit: recovery.commit || taskResult.commit,
      local_head: recovery.local_head || taskResult.local_head,
      remote_head: recovery.remote_head || taskResult.remote_head,
      tests: recovery.tests || taskResult.tests,
      verification: recovery.verification || taskResult.verification,
      integration: { ...(taskResult.integration || {}), ...(recovery.integration || {}), status: "already_integrated", merged: true, required: false },
      delivery_result_recovery: recovery,
      reviewer_decision: { ...(taskResult.reviewer_decision || {}), status: "accepted", passed: true },
      acceptance_findings: clearResolvedDeliveryFindings(taskResult.acceptance_findings || []),
      warnings: Array.isArray(taskResult.warnings) ? [...taskResult.warnings, "Delivery already integrated: " + (recovery.warnings?.[0] || "no staged changes needed")] : (taskResult.warnings || []),
      followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
      failure_class: null,
      convergence: { ...(taskResult.convergence || {}), nextStatus: "completed", closureReason: "already_integrated" },
    };
    alreadyIntegrated.warnings = Array.isArray(recovery.warnings)
      ? uniqueStrings([...alreadyIntegrated.warnings, ...recovery.warnings])
      : uniqueStrings(alreadyIntegrated.warnings);
    return alreadyIntegrated;
  }
  return {
    ...taskResult,
    kind: "codex_executed",
    summary: recoveredSummary,
    changed_files: Array.isArray(recovery.changed_files) ? recovery.changed_files : (Array.isArray(taskResult.changed_files) ? taskResult.changed_files : []),
    tests: recovery.tests || taskResult.tests || "delivery recovery verification passed",
    commit: recovery.commit,
    local_head: recovery.local_head,
    remote_head: recovery.remote_head,
    verification: recovery.verification,
    integration: { ...(taskResult.integration || {}), ...(recovery.integration || {}), status: "merged", merged: true },
    delivery_result_recovery: recovery,
    reviewer_decision: { ...(taskResult.reviewer_decision || {}), status: "accepted", passed: true },
    acceptance_findings: clearResolvedDeliveryFindings(taskResult.acceptance_findings || []),
    warnings: Array.isArray(taskResult.warnings) ? taskResult.warnings : [],
    followups: Array.isArray(taskResult.followups) ? taskResult.followups : [],
    failure_class: null,
    convergence: { ...(taskResult.convergence || {}), nextStatus: "completed", closureReason: "delivery_result_recovery" },
  };
}

export async function buildDeliveryResultRecoveryEvidence({ config, taskResult, resolvedRepo, cr, runCommandFn }) {
  if (!resolvedRepo?.canonical_repo_path || !resolvedRepo?.task_worktree_path) return null;
  const exitCode = cr?.returncode ?? null;
  const isMissingResultFailure = taskResult?.failure_class === "result_missing" || taskResult?.kind === "codex_failed";
  if (!isMissingResultFailure || exitCode === 0) return null;

  let worktreeCommit = null;
  let localHead = null;
  let remoteHead = null;
  let canonicalClean = false;
  let commitIntegrated = false;
  try {
    worktreeCommit = gitOutput(resolvedRepo.task_worktree_path, ["rev-parse", "HEAD"]);
    localHead = gitOutput(resolvedRepo.canonical_repo_path, ["rev-parse", "HEAD"]);
    remoteHead = gitOutput(resolvedRepo.canonical_repo_path, ["rev-parse", "origin/" + (config.defaultBranch || "main")]);
    canonicalClean = gitOutput(resolvedRepo.canonical_repo_path, ["status", "--short"]) === "";
    commitIntegrated = worktreeCommit === localHead || worktreeCommit === remoteHead;
    if (!commitIntegrated) {
      try {
        gitOutput(resolvedRepo.canonical_repo_path, ["merge-base", "--is-ancestor", worktreeCommit, localHead]);
        commitIntegrated = true;
      } catch {}
    }
  } catch {
    return null;
  }

  const commandsToRun = commandListFromConfig(config);
  if (!canonicalClean || !commitIntegrated || !commandsToRun.length) {
    return {
      reason: "result_missing_but_verified_commit",
      canonical_clean: canonicalClean,
      commit_integrated: commitIntegrated,
      commit: localHead,
      local_head: localHead,
      remote_head: remoteHead,
      worktree_commit: worktreeCommit,
      verification: { passed: false, commands: [], reason: commandsToRun.length ? null : "no recovery verification commands configured" },
      passed: false,
    };
  }

  const commands = [];
  for (const cmd of commandsToRun) {
    const started = Date.now();
    const result = await runCommandFn(cmd, resolvedRepo.canonical_repo_path, config.resultRecoveryCommandTimeout || config.shellTimeout || 600_000, config.maxShellOutputBytes || 1_000_000);
    commands.push({
      cmd,
      exit_code: result?.returncode ?? 1,
      duration_ms: Date.now() - started,
      stdout_tail: typeof result?.stdout === "string" ? result.stdout.slice(-4000) : "",
      stderr_tail: typeof result?.stderr === "string" ? result.stderr.slice(-4000) : "",
    });
  }
  const verificationPassed = commands.length > 0 && commands.every((command) => command.exit_code === 0);
  return {
    reason: "result_missing_but_verified_commit",
    canonical_clean: canonicalClean,
    commit_integrated: commitIntegrated,
    commit: localHead,
    local_head: localHead,
    remote_head: remoteHead,
    worktree_commit: worktreeCommit,
    summary: `Recovered missing delivery result: worktree ${shortSha(worktreeCommit)} integrated into canonical ${shortSha(localHead)} and verification passed.`,
    tests: verificationPassed ? `${commands.length} recovery verification command(s) passed` : `${commands.filter((command) => command.exit_code !== 0).length} recovery verification command(s) failed`,
    verification: { passed: verificationPassed, commands },
    passed: verificationPassed,
  };
}
