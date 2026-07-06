import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import {
  commandEvidenceFromReport,
  isVerificationReportReusable,
  readVerificationReport,
} from './verification-report.mjs';
import { normalizeOperationEvidence } from './evidence/evidence-normalizer.mjs';
import { runStateAssertions } from './assertions/state-assertion-runner.mjs';
import { verifyAcceptanceContract } from './acceptance/contract-verifier.mjs';

const execAsync = promisify(exec);
const RESULT_STATUSES = new Set(['completed', 'failed', 'timed_out', 'waiting_for_review']);
const NO_PROJECT_CHECKS_REASON = 'No project verification commands were available.';

function tail(value, max = 4000) {
  return String(value || '').slice(-max);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function defaultRunCommand(command, { cwd, timeout = 120_000 } = {}) {
  try {
    const result = await execAsync(command, {
      cwd,
      timeout,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return { cmd: command, exit_code: 0, stdout_tail: tail(result.stdout), stderr_tail: tail(result.stderr) };
  } catch (err) {
    return {
      cmd: command,
      exit_code: typeof err?.code === 'number' ? err.code : 1,
      stdout_tail: tail(err?.stdout),
      stderr_tail: tail(err?.stderr || err?.message),
    };
  }
}

function normalizeCommandResult(command, result) {
  return {
    cmd: result?.cmd || command,
    exit_code: typeof result?.exit_code === 'number' ? result.exit_code : 1,
    stdout_tail: tail(result?.stdout_tail ?? result?.stdout),
    stderr_tail: tail(result?.stderr_tail ?? result?.stderr),
  };
}

async function runCommand(command, { cwd, timeout, config } = {}) {
  const runner = typeof config?.runCommand === 'function' ? config.runCommand : defaultRunCommand;
  try {
    return normalizeCommandResult(command, await runner(command, { cwd, timeout }));
  } catch (err) {
    return {
      cmd: command,
      exit_code: 1,
      stdout_tail: '',
      stderr_tail: tail(err?.message || String(err)),
    };
  }
}

async function gitHead(repoPath, config = {}) {
  if (config.repoHead) return config.repoHead;
  if (!repoPath) return null;
  try {
    const result = await execAsync('git rev-parse HEAD', { cwd: repoPath, timeout: 15_000, encoding: 'utf8' });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function parseResultJson(resultJson, resultJsonPath) {
  if (resultJson !== undefined && resultJson !== null) {
    if (typeof resultJson === 'string') {
      try {
        return { result: JSON.parse(resultJson), findings: [] };
      } catch (err) {
        return { result: null, findings: [finding('result_json_invalid', err?.message || 'Invalid result JSON')] };
      }
    }
    if (typeof resultJson === 'object' && !Array.isArray(resultJson)) return { result: resultJson, findings: [] };
    return { result: null, findings: [finding('result_json_invalid', 'Result JSON must be an object or JSON string')] };
  }

  if (!resultJsonPath) {
    return { result: null, findings: [finding('result_json_missing', 'No task result data or resultJsonPath was provided')] };
  }

  try {
    return { result: await readJsonFile(resultJsonPath), findings: [] };
  } catch (err) {
    const code = err?.code === 'ENOENT' ? 'result_json_missing' : 'result_json_invalid';
    return { result: null, findings: [finding(code, err?.message || 'Unable to read result JSON')] };
  }
}

function finding(code, message, severity = 'blocker') {
  return { severity, code, message, source: 'task_verifier' };
}

function changedFilesFrom({ result, task, workspaceFiles }) {
  if (Array.isArray(result?.changed_files)) return result.changed_files;
  if (Array.isArray(result?.changedFiles)) return result.changedFiles;
  if (Array.isArray(task?.changed_files)) return task.changed_files;
  if (Array.isArray(workspaceFiles)) return workspaceFiles;
  return [];
}

function verificationReportPathFrom(result) {
  return result?.verification_report_path
    || result?.verification?.report_path
    || result?.evidence_paths?.verification_report
    || null;
}

async function loadAcceptanceContract({ goal = {}, result = {}, resultJsonPath = null } = {}) {
  if (goal?.acceptance_contract) return goal.acceptance_contract;
  if (result?.acceptance_contract && typeof result.acceptance_contract === 'object') return result.acceptance_contract;
  if (!resultJsonPath) return null;
  const path = join(dirname(resultJsonPath), 'acceptance.contract.json');
  try {
    return await readJsonFile(path);
  } catch {
    return null;
  }
}

function contractFindings(contractVerification = null) {
  if (!contractVerification) return [];
  return (contractVerification.blockers || []).map((blocker) => ({
    severity: blocker.severity || 'blocker',
    code: blocker.code || 'acceptance_contract_blocker',
    message: blocker.message || 'Acceptance contract blocker',
    source: blocker.source || 'acceptance_contract_verifier',
    evidence: blocker.evidence,
  }));
}

function reportProfileFrom(result, config = {}) {
  return config.verificationReportProfile || result?.verification?.profile || result?.verification_profile || 'fast';
}

async function loadReusableReport({ result, repoPath, projectCommands, config }) {
  const path = verificationReportPathFrom(result);
  if (!path) return { report: null, report_reuse: null };
  const attempted = { attempted: true, reused: false, path };
  let report = null;
  try {
    report = await readVerificationReport(path);
  } catch (err) {
    return { report: null, report_reuse: { ...attempted, reason: 'read_failed', error: err?.message || String(err) } };
  }
  const repoHead = await gitHead(repoPath, config);
  const reusable = isVerificationReportReusable(report, {
    repoHead,
    profile: reportProfileFrom(result, config),
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
  for (const key of ['expected_head', 'report_head', 'expected_profile', 'report_profile', 'missing_commands', 'matched_commands', 'completed_at', 'max_age_ms']) {
    if (reusable[key] !== undefined) report_reuse[key] = reusable[key];
  }
  return { report: reusable.reusable ? report : null, report_reuse };
}

function validateResult(result, { contract = null } = {}) {
  const findings = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [finding('result_json_invalid', 'Task result must be a JSON object')];
  }
  if (!RESULT_STATUSES.has(result.status)) {
    findings.push(finding('unsupported_result_status', `Unsupported result status: ${result.status || 'missing'}`));
  }
  if (result.status === 'completed' && !String(result.summary || '').trim()) {
    findings.push(finding('summary_missing', 'Completed result must include a summary'));
  }
  if (!contract && result.status === 'completed' && result.verification?.passed !== true) {
    findings.push(finding('verification_not_passed', 'Completed result must include verification.passed === true'));
  }
  return findings;
}

async function discoverProjectChecks(repoPath, config = {}) {
  if (Array.isArray(config.verificationCommands)) return config.verificationCommands.filter(Boolean);
  if (Array.isArray(config.projectCheckCommands)) return config.projectCheckCommands.filter(Boolean);
  if (!repoPath) return [];

  const commands = [];
  for (const packageDir of ['', 'backend', 'frontend', 'app']) {
    const packageJsonPath = join(repoPath, packageDir, 'package.json');
    if (!(await exists(packageJsonPath))) continue;
    try {
      const pkg = await readJsonFile(packageJsonPath);
      commands.push(...commandsForPackageScripts(pkg?.scripts || {}, packageDir));
    } catch {}
  }
  if (await exists(join(repoPath, 'pyproject.toml')) || await exists(join(repoPath, 'pytest.ini'))) commands.push('python -m pytest');
  if (await exists(join(repoPath, 'go.mod'))) commands.push('go test ./...');
  if (await exists(join(repoPath, 'Cargo.toml'))) commands.push('cargo test');
  if (await exists(join(repoPath, 'pom.xml'))) commands.push('mvn test');
  return [...new Set(commands)];
}

function commandsForPackageScripts(scripts, packageDir = '') {
  const commands = [];
  const prefix = packageDir ? `npm --prefix ${packageDir}` : 'npm';
  for (const script of ['check:syntax', 'check:imports', 'check', 'typecheck', 'lint', 'test', 'build']) {
    if (!scripts?.[script]) continue;
    if (script === 'test') {
      commands.push(packageDir ? `${prefix} test` : 'npm run test');
    } else {
      commands.push(`${prefix} run ${script}`);
    }
  }
  return commands;
}

async function persistVerification(resultJsonPath, verification, logger) {
  if (!resultJsonPath) return;
  const verificationPath = join(dirname(resultJsonPath), 'verification.json');
  try {
    await mkdir(dirname(verificationPath), { recursive: true });
    await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger?.warn?.('Unable to write verification.json', err);
  }
}

export async function verifyTaskCompletion({
  task = {},
  goal = {},
  repoPath,
  resultJson,
  resultJsonPath,
  workspaceFiles = [],
  config = {},
  stateStore = null,
  logger = null,
} = {}) {
  const timestamp = typeof config.now === 'function' ? config.now() : new Date().toISOString();
  const commands = [];
  const skipped_checks = [];
  const parsed = await parseResultJson(resultJson, resultJsonPath);
  const rawResult = parsed.result;
  const contract = await loadAcceptanceContract({ goal, result: rawResult, resultJsonPath });
  const result = rawResult && contract ? normalizeOperationEvidence({ result: rawResult, contract }) : rawResult;
  const findings = [...parsed.findings, ...validateResult(result, { contract })];

  if (repoPath) {
    commands.push(await runCommand('git diff --check', { cwd: repoPath, timeout: 30_000, config }));
  } else {
    skipped_checks.push({ cmd: 'git diff --check', reason: 'repoPath was not provided' });
  }

  const projectCommands = parsed.findings.some((entry) => entry.code === 'result_json_invalid')
    ? []
    : await discoverProjectChecks(repoPath, config);
  const { report, report_reuse } = await loadReusableReport({ result, repoPath, projectCommands, config });
  if (projectCommands.length === 0) {
    skipped_checks.push({ kind: 'project_checks', reason: NO_PROJECT_CHECKS_REASON });
  }
  for (const command of projectCommands) {
    const reused = report ? commandEvidenceFromReport(report, command) : null;
    commands.push(reused || await runCommand(command, { cwd: repoPath || process.cwd(), timeout: config.verificationCommandTimeout || 120_000, config }));
  }

  if (commands.some((command) => command.exit_code !== 0)) {
    findings.push(finding('verification_command_failed', 'One or more verification commands failed'));
  }

  const changed_files = changedFilesFrom({ result, task, workspaceFiles });
  const reason_no_tests = projectCommands.length === 0 ? NO_PROJECT_CHECKS_REASON : null;
  const stateAssertions = contract ? await runStateAssertions({
    contract,
    result: result || {},
    repoPath,
    workspaceRoot: config.workspaceRoot || config.defaultWorkspaceRoot,
    runtimeContext: config.runtimeContext || {},
    config,
  }) : null;
  const contract_verification = contract ? verifyAcceptanceContract({
    contract,
    task,
    goal,
    result: result || {},
    verification: { commands, report_reuse, passed: findings.length === 0 && commands.every((command) => command.exit_code === 0) },
    stateAssertions,
    repoState: { repoPath },
  }) : null;
  // P0-AFC3: Contract verification provides evidence, not independent decisions.
  // The canonical decider (decideTaskClosure) handles outcome determination.
  // Blockers from contract verification are included unconditionally as evidence.
  if (contract_verification?.blocking_passed === false) {
    findings.push(...contractFindings(contract_verification));
  }

  const passed = findings.length === 0 && commands.every((command) => command.exit_code === 0) && (contract_verification ? contract_verification.completion_eligible === true : true);
  const verification = {
    passed,
    status: passed ? 'completed' : 'waiting_for_review',
    commands,
    skipped_checks,
    changed_files,
    reason_no_tests,
    timestamp,
    task_id: task?.id || null,
    goal_id: goal?.id || null,
    findings,
    contract_verification,
  };
  if (report_reuse) verification.report_reuse = report_reuse;

  await persistVerification(resultJsonPath, verification, logger);
  if (stateStore && typeof stateStore.save === 'function') await stateStore.save();
  return verification;
}
