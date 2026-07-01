import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { verifyTaskCompletion } from './task-verifier.mjs';
import { verifyAcceptanceContract } from './acceptance/contract-verifier.mjs';
import { decideTaskClosure } from './closure/task-closure-decider.mjs';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadResult({ resultJson, resultJsonPath } = {}) {
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) return resultJson;
  if (typeof resultJson === 'string') return JSON.parse(resultJson);
  if (resultJsonPath) return readJson(resultJsonPath);
  return {};
}

async function loadContract({ goal = {}, result = {}, resultJsonPath = null } = {}) {
  if (goal?.acceptance_contract && typeof goal.acceptance_contract === 'object') return goal.acceptance_contract;
  if (result?.acceptance_contract && typeof result.acceptance_contract === 'object') return result.acceptance_contract;
  if (!resultJsonPath) return null;
  try {
    return await readJson(join(dirname(resultJsonPath), 'acceptance.contract.json'));
  } catch {
    return null;
  }
}

function verifierErrorReport(err, { task = {}, goal = {}, now } = {}) {
  const timestamp = typeof now === 'function' ? now() : new Date().toISOString();
  return {
    passed: false,
    status: 'waiting_for_review',
    commands: [],
    skipped_checks: [],
    changed_files: [],
    reason_no_tests: null,
    timestamp,
    task_id: task?.id || null,
    goal_id: goal?.id || null,
    findings: [{
      severity: 'blocker',
      code: 'verifier_error',
      message: err?.message || String(err),
      source: 'acceptance_gate_engine',
    }],
    contract_verification: null,
  };
}

function contractVerificationFrom({ contract, verification, result, task, goal, repoPath } = {}) {
  if (verification?.contract_verification) return verification.contract_verification;
  if (!contract) return null;
  return verifyAcceptanceContract({
    contract,
    task,
    goal,
    result,
    verification,
    stateAssertions: { passed: true, assertions: [], failures: [] },
    repoState: { repoPath },
  });
}

function gateStatusFrom({ closureDecision = {}, result = {}, verification = {} } = {}) {
  if (closureDecision.status === 'failed' || result.status === 'failed') return 'failed';
  if (closureDecision.auto_complete_allowed === true && verification.passed === true) return 'passed';
  return 'needs_action';
}

function findingsFrom({ verification = {}, contractVerification = {}, closureDecision = {}, status } = {}) {
  verification = asObject(verification);
  contractVerification = asObject(contractVerification);
  closureDecision = asObject(closureDecision);
  const findings = [
    ...normalizeList(verification.findings),
    ...normalizeList(contractVerification.blockers),
    ...normalizeList(closureDecision.blockers),
    ...normalizeList(closureDecision.repairable_blockers),
  ];
  if (status === 'failed' && !findings.some((finding) => finding?.code === 'result_failed')) {
    findings.push({ severity: 'blocker', code: 'result_failed', message: 'Task result is failed.', source: 'acceptance_gate_engine' });
  }

  const deduped = [];
  const seen = new Set();
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const key = `${finding.code || ''}\n${finding.message || ''}\n${finding.source || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

async function writeJson(path, data) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function artifactPaths(resultJsonPath) {
  if (!resultJsonPath) return { verificationPath: null, acceptancePath: null };
  const dir = dirname(resultJsonPath);
  return {
    verificationPath: join(dir, 'verification.json'),
    acceptancePath: join(dir, 'acceptance.json'),
  };
}

export async function runAcceptanceGate({
  task = {},
  goal = {},
  repoPath,
  resultJson,
  resultJsonPath,
  workspaceFiles = [],
  config = {},
  verification = null,
  verifyTaskCompletionFn = verifyTaskCompletion,
  now = null,
  writeArtifacts = true,
} = {}) {
  const timestamp = typeof now === 'function' ? now() : (typeof config.now === 'function' ? config.now() : new Date().toISOString());
  const result = await loadResult({ resultJson, resultJsonPath }).catch((err) => ({
    status: 'failed',
    summary: `Unable to load result.json: ${err?.message || String(err)}`,
    changed_files: [],
    verification: { passed: false },
  }));
  const contract = await loadContract({ goal, result, resultJsonPath });
  const { verificationPath, acceptancePath } = artifactPaths(resultJsonPath);

  let verifier = verification;
  if (!verifier) {
    try {
      verifier = await verifyTaskCompletionFn({ task, goal, repoPath, resultJson: result, resultJsonPath, workspaceFiles, config });
    } catch (err) {
      verifier = verifierErrorReport(err, { task, goal, now: () => timestamp });
    }
  }
  verifier = asObject(verifier);
  if (writeArtifacts) await writeJson(verificationPath, verifier).catch(() => {});

  const contractVerification = contractVerificationFrom({ contract, verification: verifier, result, task, goal, repoPath });
  const closureDecision = decideTaskClosure({
    contract,
    contractVerification,
    verification: verifier,
    integration: result.integration,
    deployment: result.deployment || result.runtime || null,
    result,
    task,
    config,
  });
  const status = gateStatusFrom({ closureDecision, result, verification: verifier });
  const acceptance = {
    schema_version: 1,
    status,
    passed: status === 'passed',
    task_status: closureDecision.task_status,
    reason: closureDecision.reason,
    timestamp,
    task_id: task?.id || null,
    goal_id: goal?.id || null,
    verification: verifier,
    contract_verification: contractVerification,
    closure_decision: closureDecision,
    findings: findingsFrom({ verification: verifier, contractVerification, closureDecision, status }),
    artifacts: {
      verification_json: verificationPath,
      acceptance_json: acceptancePath,
    },
  };
  if (writeArtifacts) await writeJson(acceptancePath, acceptance).catch(() => {});
  return acceptance;
}
