import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildEvidence, runAcceptanceAgent } from "./acceptance-agent.mjs";
import { classifyFailure } from "./failure-classifier.mjs";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function tail(value, max = 4000) {
  return String(value || "").slice(-max);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, { cwd, timeout = 120_000, runCommandFn } = {}) {
  if (typeof runCommandFn === "function") return runCommandFn(command, { cwd, timeout });
  const isArrayCommand = Array.isArray(command);
  const [cmd, ...args] = isArrayCommand ? command : [];
  const commandText = isArrayCommand ? [cmd, ...args].join(" ") : String(command || "").trim();
  if (!commandText) return { cmd: String(command), exit_code: 1, stdout_tail: "", stderr_tail: "empty command" };
  if (isArrayCommand && !cmd) return { cmd: String(command), exit_code: 1, stdout_tail: "", stderr_tail: "empty command" };
  try {
    const result = isArrayCommand
      ? await execFileAsync(cmd, args, { cwd, timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })
      : await execAsync(commandText, { cwd, timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return { cmd: commandText, exit_code: 0, stdout_tail: tail(result.stdout), stderr_tail: tail(result.stderr) };
  } catch (err) {
    return {
      cmd: commandText,
      exit_code: typeof err?.code === "number" ? err.code : 1,
      stdout_tail: tail(err?.stdout),
      stderr_tail: tail(err?.stderr || err?.message),
    };
  }
}

async function discoverCommands(repoPath) {
  const commands = [];
  if (await exists(join(repoPath, "package.json"))) {
    let pkg = {};
    try { pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")); } catch {}
    const scripts = pkg.scripts || {};
    for (const name of ["test", "build", "typecheck", "lint"]) {
      if (scripts[name]) commands.push(`npm run ${name}`);
    }
  }
  if (await exists(join(repoPath, "pyproject.toml")) || await exists(join(repoPath, "pytest.ini"))) commands.push("python -m pytest");
  if (await exists(join(repoPath, "go.mod"))) commands.push("go test ./...");
  if (await exists(join(repoPath, "Cargo.toml"))) commands.push("cargo test");
  if (await exists(join(repoPath, "pom.xml"))) commands.push("mvn test");
  return [...new Set(commands)];
}

function normalizeResultJson(input) {
  if (!input) return { ok: false, error: "result.json missing", result: null };
  if (typeof input === "object") return { ok: true, result: input };
  try {
    return { ok: true, result: JSON.parse(String(input)) };
  } catch (err) {
    return { ok: false, error: err?.message || "invalid result.json", result: null };
  }
}

function changedFilesFrom(task = {}, result = {}) {
  return Array.isArray(result.changed_files) ? result.changed_files
    : Array.isArray(task.changed_files) ? task.changed_files : [];
}

function isNoopProfile(task = {}, result = {}) {
  return task.mode === "noop" || task.noop === true || result.noop === true || result.kind === "noop";
}

function isEvidenceGatedNoChangeProfile(task = {}, result = {}) {
  return ["sync", "github_sync", "admin", "restart"].includes(task.mode) ||
    result.sync_only === true || result.admin === true || result.restart_state != null || result.restart_verified_at != null;
}

function hasNoopEvidence(result = {}) {
  return result.noop === true || result.kind === "noop" || Boolean(result.noop_reason);
}

function hasProfileEvidence(task = {}, result = {}) {
  if (isNoopProfile(task, result)) return hasNoopEvidence(result);
  if (task.mode === "admin") return result.verification?.passed === true && Boolean(result.admin_action || result.audit_id || result.admin_evidence || result.tests);
  if (task.mode === "restart" || result.restart_state != null || result.restart_verified_at != null) {
    return result.verification?.passed === true && (result.restart_state === "verified" || Boolean(result.restart_verified_at) || result.post_restart_verified === true);
  }
  return result.verification?.passed === true;
}

export async function verifyTaskCompletion({ task = {}, goal = {}, repoPath, resultJson, resultJsonPath, config = {}, stateStore = null, runCommandFn = null } = {}) {
  const commands = [];
  const findings = [];
  let parsed = normalizeResultJson(resultJson);

  if (!parsed.ok && resultJsonPath) {
    try {
      parsed = normalizeResultJson(await readFile(resultJsonPath, "utf8"));
    } catch (err) {
      parsed = { ok: false, error: err?.message || "result.json missing", result: null };
    }
  }

  if (!parsed.ok) {
    findings.push({ severity: "blocker", code: "result_json_invalid", message: parsed.error, source: "task_acceptance" });
  }

  const result = parsed.result || {};
  const status = result.status || "failed";
  if (!new Set(["completed", "waiting_for_review", "failed"]).has(status)) {
    findings.push({ severity: "blocker", code: "unsupported_result_status", message: `Unsupported result status: ${status}`, source: "task_acceptance" });
  }
  if (status === "completed" && !result.summary) {
    findings.push({ severity: "blocker", code: "summary_missing", message: "Completed result must include summary", source: "task_acceptance" });
  }
  if (status === "completed" && result.verification?.passed !== true) {
    const changedFiles = changedFilesFrom(task, result);
    if (changedFiles.length > 0 || task.mode === "deploy" || isEvidenceGatedNoChangeProfile(task, result)) {
      findings.push({ severity: "blocker", code: "verification_failed", message: "Completed result requires verification.passed === true", source: "task_acceptance" });
    }
  }
  if (status === "completed" && !result.verification) {
    const changedFiles = changedFilesFrom(task, result);
    if (changedFiles.length > 0 || task.mode === "deploy" || isEvidenceGatedNoChangeProfile(task, result)) {
      findings.push({ severity: "blocker", code: "verification_missing", message: "Completed result must include verification object", source: "task_acceptance" });
    }
  }

  if (repoPath) {
    commands.push(await runCommand("git diff --check", { cwd: repoPath, timeout: 30_000, runCommandFn }));
  }
  const discovered = config.discoverVerificationCommands === false ? [] : await discoverCommands(repoPath || process.cwd());
  for (const command of discovered) {
    commands.push(await runCommand(command, { cwd: repoPath || process.cwd(), timeout: config.verificationCommandTimeout || 120_000, runCommandFn }));
  }

  if (commands.some((command) => command.exit_code !== 0)) {
    findings.push({ severity: "blocker", code: "verification_command_failed", message: "One or more verification commands failed", source: "task_acceptance" });
  }
  if (commands.length === 0) {
    findings.push({ severity: "followup", code: "no_verification_commands", message: "No verification command could be run", source: "task_acceptance" });
  }

  const evidence = parsed.ok ? await buildTaskAcceptanceEvidence({ result, repoPath, resultJsonPath }) : null;
  const acceptance = parsed.ok ? await runAcceptanceAgent({
    task,
    goal,
    result,
    repoPath,
    evidence,
  }).catch((err) => ({ passed: false, findings: [{ severity: "major", code: "acceptance_agent_error", message: err?.message || String(err), source: "task_acceptance" }], evidence })) : { passed: false, findings: [], evidence: null };

  findings.push(...(acceptance.findings || []).filter((finding) => finding.severity === "blocker" || finding.severity === "major"));

  if (status === "completed" && isNoopProfile(task, result) && !hasNoopEvidence(result)) {
    findings.push({ severity: "blocker", code: "noop_evidence_missing", message: "Completed noop tasks require noop=true, kind=noop, or noop_reason evidence", source: "task_acceptance" });
  }
  if (status === "completed" && isEvidenceGatedNoChangeProfile(task, result) && !hasProfileEvidence(task, result)) {
    findings.push({ severity: "blocker", code: "profile_evidence_missing", message: "Completed sync/admin/restart no-change tasks require explicit verification/evidence", source: "task_acceptance" });
  }

  const hardFailed = findings.some((finding) => finding.severity === "blocker" || finding.severity === "major");
  const noChangeProfileSatisfied = changedFilesFrom(task, result).length === 0 &&
    (isNoopProfile(task, result) ? hasNoopEvidence(result) : isEvidenceGatedNoChangeProfile(task, result) && hasProfileEvidence(task, result));
  const passed = parsed.ok && status === "completed" && (noChangeProfileSatisfied || result.verification?.passed === true) && commands.every((command) => command.exit_code === 0) && !hardFailed;
  const failureClass = passed ? null : classifyFailure({ resultJson: result, message: findings.map((f) => f.code).join(" ") }) || "unknown";
  const verification = {
    passed,
    status: passed ? "completed" : "waiting_for_review",
    commands,
    changed_files: Array.isArray(result.changed_files) ? result.changed_files : [],
    reason_no_tests: commands.length <= (repoPath ? 1 : 0) ? "No project verification commands discovered beyond fallback checks." : null,
    failure_class: failureClass === "unknown" && !passed ? (result.verification?.passed === false ? "verification_failed" : "unknown") : failureClass,
    requires_review: !passed,
    findings,
    evidence: acceptance.evidence || evidence || null,
  };

  if (resultJsonPath) {
    await writeFile(join(dirname(resultJsonPath), "verification.json"), JSON.stringify(verification, null, 2), "utf8").catch(() => {});
  }
  if (stateStore && typeof stateStore.save === "function") {
    await stateStore.save().catch(() => {});
  }
  return verification;
}

async function buildTaskAcceptanceEvidence({ result, repoPath, resultJsonPath } = {}) {
  const evidence = repoPath
    ? await buildEvidence({ repoPath, resultJsonPath: resultJsonPath || result?.result_json_path, verificationLogPath: result?.verification_log_path })
    : {
        git_status: "unknown",
        git_diff_summary: null,
        commit_exists: "unknown",
        changed_files: [],
        verification_log_exists: false,
        result_json_valid: null,
      };

  evidence.result_json_valid = true;
  evidence.result_summary = result?.summary || "";
  evidence.changed_files = Array.isArray(result?.changed_files) ? result.changed_files : evidence.changed_files || [];
  evidence.verification_log_exists = evidence.verification_log_exists === true
    || (Array.isArray(result?.verification?.commands) && result.verification.commands.length > 0);
  if (!repoPath) {
    evidence.git_status = "unknown";
    evidence.commit_exists = "unknown";
  }
  return evidence;
}
