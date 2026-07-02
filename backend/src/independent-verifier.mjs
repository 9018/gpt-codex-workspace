/**
 * independent-verifier.mjs — Independent verifier module.
 *
 * Provides an independent verification flow that:
 * - Accepts task result data / result.json path as input
 * - Runs verification commands independently (not tied to task lifecycle)
 * - Collects verification evidence (git status, diff, changed files)
 * - Generates structured verification result files
 * - Returns a pass/fail/needs_continue judgment
 *
 * This module can be invoked standalone by tools, scripts, or automated
 * pipelines that need to verify a completed result before it enters the
 * acceptance gate.
 *
 * G5 dependency: relies on G4 context curator file paths for discovery
 * of verification artifacts within goal workspace directories.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

import {
  createVerificationResult,
  writeVerificationResultFile,
  readVerificationResultFile,
} from "./verification-result-file.mjs";

import {
  commandFingerprint,
  commandSatisfiesRequirement,
  isVerificationReportReusable,
  readVerificationReport,
  commandEvidenceFromReport,
  verificationReportToEvidence,
} from "./verification-report.mjs";

const execAsync = promisify(exec);

const RESULT_STATUSES = new Set(["completed", "failed", "timed_out", "waiting_for_review"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tail(value, max = 4000) {
  return String(value || "").slice(-max);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

async function readJsonFile(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

async function defaultRunCommand(command, { cwd, timeout = 120_000 } = {}) {
  const cmdText = String(command || "").trim();
  if (!cmdText) {
    return { cmd: String(command), exit_code: 1, stdout_tail: "", stderr_tail: "empty command" };
  }
  try {
    const result = await execAsync(cmdText, {
      cwd,
      timeout,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { cmd: cmdText, exit_code: 0, stdout_tail: tail(result.stdout), stderr_tail: tail(result.stderr) };
  } catch (err) {
    return {
      cmd: cmdText,
      exit_code: typeof err?.code === "number" ? err.code : 1,
      stdout_tail: tail(err?.stdout),
      stderr_tail: tail(err?.stderr || err?.message),
    };
  }
}

// ---------------------------------------------------------------------------
// Result loading
// ---------------------------------------------------------------------------

async function loadResult({ resultJson, resultJsonPath } = {}) {
  if (resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)) return resultJson;
  if (typeof resultJson === "string") return JSON.parse(resultJson);
  if (resultJsonPath) {
    try {
      return await readJsonFile(resultJsonPath);
    } catch (err) {
      return { status: "failed", summary: `Unable to load result: ${err.message}`, load_error: err.message };
    }
  }
  return {};
}

async function loadAcceptanceContract({ goal = {}, result = {}, resultDir = null } = {}) {
  if (goal?.acceptance_contract) return goal.acceptance_contract;
  if (result?.acceptance_contract && typeof result.acceptance_contract === "object") return result.acceptance_contract;
  if (!resultDir) return null;
  try {
    return await readJsonFile(join(resultDir, "acceptance.contract.json"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

async function gitHead(repoPath) {
  if (!repoPath) return null;
  try {
    const result = await execAsync("git rev-parse HEAD", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function collectGitEvidence(repoPath) {
  if (!repoPath) return { git_status: null, diff_stat: null, changed_files: [], implementation_diff_patch: null };

  const evidence = { git_status: null, diff_stat: null, changed_files: [], implementation_diff_patch: null };

  // git status
  try {
    const { stdout } = await execAsync("git status --porcelain", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
    evidence.git_status = stdout || null;
  } catch { /* ignore */ }

  // diff stat (HEAD~1..HEAD or initial)
  try {
    const { stdout } = await execAsync("git diff HEAD~1..HEAD --stat", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
    evidence.diff_stat = stdout || null;
  } catch {
    try {
      const { stdout } = await execAsync("git diff --cached --stat", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
      evidence.diff_stat = stdout || null;
    } catch { /* ignore */ }
  }

  // changed files
  try {
    const { stdout } = await execAsync("git diff HEAD~1..HEAD --name-only", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
    evidence.changed_files = stdout ? stdout.trim().split("\n").filter(Boolean) : [];
  } catch {
    try {
      const { stdout } = await execAsync("git diff --cached --name-only", { cwd: repoPath, timeout: 15_000, encoding: "utf8" });
      evidence.changed_files = stdout ? stdout.trim().split("\n").filter(Boolean) : [];
    } catch { /* ignore */ }
  }

  // diff patch
  try {
    const { stdout } = await execAsync("git diff HEAD~1..HEAD --", { cwd: repoPath, timeout: 15_000, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
    evidence.implementation_diff_patch = stdout || null;
  } catch {
    try {
      const { stdout } = await execAsync("git diff --cached --", { cwd: repoPath, timeout: 15_000, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
      evidence.implementation_diff_patch = stdout || null;
    } catch { /* ignore */ }
  }

  return evidence;
}

async function discoverProjectCommands(repoPath, config = {}) {
  if (Array.isArray(config.verificationCommands)) return config.verificationCommands.filter(Boolean);
  if (Array.isArray(config.projectCheckCommands)) return config.projectCheckCommands.filter(Boolean);
  if (!repoPath) return [];

  const commands = [];
  for (const packageDir of ["", "backend", "frontend", "app"]) {
    const pkgPath = join(repoPath, packageDir, "package.json");
    if (!(await fileExists(pkgPath))) continue;
    try {
      const pkg = await readJsonFile(pkgPath);
      const scripts = pkg.scripts || {};
      const prefix = packageDir ? `npm --prefix ${packageDir}` : "npm";
      for (const script of ["check:syntax", "check:imports", "check", "typecheck", "lint", "test", "build"]) {
        if (scripts[script]) {
          commands.push(script === "test" ? `${prefix} test` : `${prefix} run ${script}`);
        }
      }
    } catch { /* ignore */ }
  }
  return [...new Set(commands)];
}

// ---------------------------------------------------------------------------
// Verification report reuse
// ---------------------------------------------------------------------------

function verificationReportPathFrom(result) {
  return result?.verification_report_path
    || result?.verification?.report_path
    || result?.evidence_paths?.verification_report
    || null;
}

async function loadReusableReport({ result, repoPath, projectCommands, config }) {
  const path = verificationReportPathFrom(result);
  if (!path) return { report: null, report_reuse: null };
  const attempted = { attempted: true, reused: false, path };
  let report = null;
  try {
    report = await readVerificationReport(path);
  } catch (err) {
    return { report: null, report_reuse: { ...attempted, reason: "read_failed", error: err?.message || String(err) } };
  }
  const repoHead = config.repoHead || await gitHead(repoPath);
  const reusable = isVerificationReportReusable(report, {
    repoHead,
    profile: config.verificationReportProfile || result?.verification?.profile || "fast",
    requiredCommands: projectCommands,
    maxAgeMs: config.verificationReportMaxAgeMs,
    now: config.now,
  });
  const report_reuse = {
    ...attempted,
    reused: reusable.reusable,
    reason: reusable.reason,
    path,
    profile: reusable.profile,
    head: reusable.head,
  };
  for (const key of ["expected_head", "report_head", "expected_profile", "report_profile", "missing_commands", "matched_commands", "completed_at", "max_age_ms"]) {
    if (reusable[key] !== undefined) report_reuse[key] = reusable[key];
  }
  return { report: reusable.reusable ? report : null, report_reuse };
}

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

function validateResult(result, { contract = null } = {}) {
  const findings = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [{ severity: "blocker", code: "result_json_invalid", message: "Task result must be a JSON object", source: "independent_verifier" }];
  }
  if (!RESULT_STATUSES.has(result.status)) {
    findings.push({ severity: "blocker", code: "unsupported_result_status", message: `Unsupported result status: ${result.status || "missing"}`, source: "independent_verifier" });
  }
  if (result.status === "completed" && !String(result.summary || "").trim()) {
    findings.push({ severity: "blocker", code: "summary_missing", message: "Completed result must include a summary", source: "independent_verifier" });
  }
  if (!contract && result.status === "completed" && result.verification?.passed !== true) {
    findings.push({ severity: "blocker", code: "verification_not_passed", message: "Completed result must include verification.passed === true", source: "independent_verifier" });
  }
  return findings;
}

/**
 * Determine the verification judgment based on findings, command results,
 * and task status.
 *
 * @returns {"passed"|"failed"|"needs_continue"}
 */
function determineJudgment({ hasBlockers, allCommandsPassed, resultStatus, findingsCount }) {
  // Blocker findings → failed regardless of command results
  if (hasBlockers) return "failed";

  // All commands passed and result is completed → passed
  if (allCommandsPassed && resultStatus === "completed") return "passed";

  // All commands passed but result not completed → needs_continue
  // (The result hasn't reached completion; verification alone isn't enough)
  if (allCommandsPassed && resultStatus !== "completed") return "needs_continue";

  // Commands failed but no explicit blockers → needs_continue
  if (!allCommandsPassed && !hasBlockers) return "needs_continue";

  // Fallback
  return "needs_continue";
}

/**
 * Run independent verification on a task result.
 *
 * This is the main entry point for the independent verifier. It accepts a task
 * result (as object or file path), runs verification commands, collects git
 * evidence, reuses valid verification reports when available, and produces a
 * structured verification result with a pass/fail/needs_continue judgment.
 *
 * @param {object} options
 * @param {object} [options.result] — Task result object (parsed result.json)
 * @param {string} [options.resultJsonPath] — Path to result.json file
 * @param {object} [options.goal] — Goal object (for contract and metadata)
 * @param {object} [options.task] — Task object (for identification)
 * @param {string} [options.repoPath] — Path to git repository for evidence collection
 * @param {Array<string>} [options.verificationCommands] — Explicit commands to run
 * @param {(cmd:string,opts:object) => Promise<object>} [options.runCommand] — Custom command runner
 * @param {object} [options.config] — Configuration overrides
 * @param {boolean} [options.writeResultFile=true] — Whether to write verification.json
 * @param {string|null} [options.outputDir] — Custom output directory for verification result file
 * @returns {Promise<{judgment:string,passed:boolean,needs_continue:boolean,failed:boolean,verification:object,result_file_path:string|null}>}
 */
export async function runIndependentVerification({
  result = null,
  resultJsonPath = null,
  goal = {},
  task = {},
  repoPath = null,
  verificationCommands = null,
  runCommand = null,
  config = {},
  writeResultFile = true,
  outputDir = null,
} = {}) {
  const runCommandFn = runCommand || defaultRunCommand;
  const timestamp = typeof config.now === "function" ? config.now() : new Date().toISOString();
  const commands = [];
  const skipped_checks = [];
  const findings = [];

  // 1. Load result
  const parsed = await loadResult({ resultJson: result, resultJsonPath });

  // Early return for truly null/empty results
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const judgment = "failed";
    const vr = createVerificationResult({
      judgment,
      findings: [{ severity: "blocker", code: "result_load_failed", message: "Unable to load task result", source: "independent_verifier" }],
      metadata: { input: { resultJsonPath, repoPath } },
    });
    const outputPath = outputDir ? join(outputDir, "verification.json") : null;
    if (writeResultFile && outputPath) await writeVerificationResultFile(outputPath, vr);
    return { judgment, passed: false, needs_continue: false, failed: true, verification: vr, result_file_path: outputPath };
  }

  // 1b. Early return for load errors
  if (parsed.load_error) {
    const judgment = "failed";
    const vr = createVerificationResult({
      judgment,
      findings: [{ severity: "blocker", code: "result_load_failed", message: parsed.summary || parsed.load_error, source: "independent_verifier" }],
      metadata: { input: { resultJsonPath, repoPath } },
    });
    const outputPath = outputDir ? join(outputDir, "verification.json") : null;
    if (writeResultFile && outputPath) await writeVerificationResultFile(outputPath, vr);
    return { judgment, passed: false, needs_continue: false, failed: true, verification: vr, result_file_path: outputPath };
  }

  // 2. Determine result directory
  const resultDir = outputDir || (resultJsonPath ? dirname(resultJsonPath) : null);

  // 3. Load acceptance contract (from goal or result directory)
  const contract = await loadAcceptanceContract({ goal, result: parsed, resultDir });

  // 4. Validate result shape
  findings.push(...validateResult(parsed, { contract }));

  // 5. Check git diff whitespace
  if (repoPath) {
    commands.push(await runCommandFn("git diff --check", { cwd: repoPath, timeout: 30_000 }));
  } else {
    skipped_checks.push({ cmd: "git diff --check", reason: "repoPath was not provided" });
  }

  // 6. Discover project commands
  const isResultInvalid = findings.some(f => f.code === "result_json_invalid");
  const projectCommands = isResultInvalid ? [] : (verificationCommands || await discoverProjectCommands(repoPath, config));

  // 7. Try to reuse a verification report
  const { report, report_reuse } = await loadReusableReport({ result: parsed, repoPath, projectCommands, config });

  if (projectCommands.length === 0 && !isResultInvalid) {
    skipped_checks.push({ cmd: "project_checks", reason: "No project verification commands were available or discovered." });
  }

  // 8. Run or reuse project verification commands
  for (const command of projectCommands) {
    const reused = report ? commandEvidenceFromReport(report, command) : null;
    if (reused) {
      commands.push(reused);
    } else {
      commands.push(await runCommandFn(command, { cwd: repoPath || process.cwd(), timeout: config.verificationCommandTimeout || 120_000 }));
    }
  }

  // 9. Check for command failures
  const commandFailures = commands.filter(c => c.exit_code !== 0 && c.exit_code !== undefined);
  if (commandFailures.length > 0) {
    findings.push({ severity: "blocker", code: "verification_command_failed", message: `One or more verification commands failed: ${commandFailures.map(c => c.cmd).join(", ")}`, source: "independent_verifier" });
  }

  // 10. Collect git evidence
  const gitEvidence = await collectGitEvidence(repoPath);
  const changedFiles = normalizeList(parsed.changed_files).length > 0
    ? parsed.changed_files
    : gitEvidence.changed_files;

  // 11. Determine judgment
  const hasBlockers = findings.some(f => f.severity === "blocker" || f.severity === "major");
  const allCommandsPassed = commands.every(c => c.exit_code === 0 || c.exit_code === undefined);
  const resultStatus = parsed.status || "unknown";

  const judgment = determineJudgment({ hasBlockers, allCommandsPassed, resultStatus, findingsCount: findings.length });

  // 12. Build verification result
  const verificationResult = createVerificationResult({
    judgment,
    commands,
    findings,
    changed_files: changedFiles,
    skipped_checks,
    reason_no_tests: projectCommands.length === 0 ? "No project verification commands were discovered." : null,
    contract_verification: contract ? { contract_present: true } : null,
    metadata: {
      repo_path: repoPath,
      result_json_path: resultJsonPath,
      project_commands_count: projectCommands.length,
      commands_executed: commands.length,
      commands_failed: commandFailures.length,
      git_evidence_collected: Boolean(gitEvidence.git_status),
      report_reuse_attempted: Boolean(report_reuse),
      report_reuse_successful: report_reuse?.reused === true,
    },
    task_id: task?.id || null,
    goal_id: goal?.id || null,
  });

  // 13. Write result file
  let resultFilePath = null;
  if (writeResultFile) {
    const outDir = outputDir || resultDir;
    if (outDir) {
      resultFilePath = join(outDir, "verification.json");
      await writeVerificationResultFile(resultFilePath, verificationResult);
    }
  }

  return {
    judgment,
    passed: judgment === "passed",
    needs_continue: judgment === "needs_continue",
    failed: judgment === "failed",
    verification: verificationResult,
    result_file_path: resultFilePath,
  };
}

// ---------------------------------------------------------------------------
// Convenience: run from file path
// ---------------------------------------------------------------------------

/**
 * Run independent verification from a result.json file path.
 * This is the simplest entry point for standalone usage.
 *
 * @param {string} resultJsonPath — Path to result.json
 * @param {object} [options] — Additional options passed to runIndependentVerification
 * @returns {Promise<object>} verification result with judgment
 */
export async function verifyFromFile(resultJsonPath, options = {}) {
  return runIndependentVerification({
    resultJsonPath,
    outputDir: dirname(resultJsonPath),
    ...options,
  });
}
