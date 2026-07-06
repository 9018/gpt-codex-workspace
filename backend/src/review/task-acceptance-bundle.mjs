import { REVIEW_STATES } from '../task-review-status-taxonomy.mjs';

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { goalWorkspaceFiles } from '../goal-files.mjs';
import { ensureGoalState } from '../task-lifecycle.mjs';

const MAX_ITEMS = 50;
const MAX_TEXT = 500;
const TERMINAL_OR_REVIEW = new Set(['completed', 'failed', 'timed_out', 'waiting_for_review', 'waiting_for_integration', ...Object.values(REVIEW_STATES)]);

function trimText(value, max = MAX_TEXT) {
  if (value === null || value === undefined) return value ?? null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactList(value, max = MAX_ITEMS) {
  return asArray(value).filter((item) => item !== null && item !== undefined).slice(0, max);
}

function compactFinding(finding = {}) {
  if (typeof finding === 'string') return { message: trimText(finding) };
  return {
    severity: finding.severity || null,
    code: finding.code || null,
    message: trimText(finding.message || finding.title || finding.reason || ''),
    source: finding.source || null,
  };
}

function compactCommand(command = {}) {
  if (typeof command === 'string') return { cmd: trimText(command, 240), exit_code: null, passed: null, reused: null };
  return {
    cmd: trimText(command.cmd || command.command || '', 240),
    exit_code: Number.isFinite(command.exit_code) ? command.exit_code : null,
    passed: typeof command.passed === 'boolean' ? command.passed : (Number.isFinite(command.exit_code) ? command.exit_code === 0 : null),
    reused: command.reused === true ? true : null,
  };
}

export function compactVerification(verification = null) {
  if (!verification || typeof verification !== 'object') return { passed: null, status: 'missing', commands: [] };
  const commands = compactList(verification.commands).map(compactCommand);
  return {
    passed: typeof verification.passed === 'boolean' ? verification.passed : null,
    status: verification.status || null,
    commands,
    report_reuse: verification.report_reuse ? {
      reused: verification.report_reuse.reused === true,
      reason: trimText(verification.report_reuse.reason || ''),
    } : null,
    findings: compactList(verification.findings).map(compactFinding),
  };
}

export function compactContractVerification(contractVerification = null) {
  if (!contractVerification || typeof contractVerification !== 'object') return null;
  return {
    contract_valid: typeof contractVerification.contract_valid === 'boolean' ? contractVerification.contract_valid : null,
    blocking_passed: typeof contractVerification.blocking_passed === 'boolean' ? contractVerification.blocking_passed : null,
    acceptance_status: contractVerification.acceptance_status || null,
    completion_eligible: typeof contractVerification.completion_eligible === 'boolean' ? contractVerification.completion_eligible : null,
    requires_review: contractVerification.requires_review === true,
    blockers: compactList(contractVerification.blockers).map(compactFinding),
    non_blocking_followups: compactList(contractVerification.non_blocking_followups).map(compactFinding),
    quality_notes: compactList(contractVerification.quality_notes).map((note) => trimText(note, 240)),
    state_assertions: contractVerification.state_assertions ? {
      passed: contractVerification.state_assertions.passed === true,
      failures: compactList(contractVerification.state_assertions.failures).map(compactFinding),
    } : null,
  };
}

function compactClosureDecision(closureDecision = null) {
  if (!closureDecision || typeof closureDecision !== 'object') return null;
  return {
    status: closureDecision.status || null,
    reason: trimText(closureDecision.reason || closureDecision.summary || ''),
    next_status: closureDecision.next_status || closureDecision.task_status || null,
  };
}

function compactIntegration(integration = null) {
  if (!integration || typeof integration !== 'object') return null;
  return {
    status: integration.status || null,
    merged: typeof integration.merged === 'boolean' ? integration.merged : null,
    pushed: typeof integration.pushed === 'boolean' ? integration.pushed : null,
    commit: integration.commit || integration.merge_commit || null,
    pr_url: integration.pr_url || integration.pull_request_url || null,
  };
}

function compactNoChangeRepair(summary = null) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    kind: summary.kind || null,
    completion_eligible: summary.completion_eligible === true,
    reason: trimText(summary.reason || ''),
    changed_files_empty_acceptable: summary.changed_files_empty_acceptable === true,
    explanation: trimText(summary.explanation || '', 320),
    affected_files: compactList(summary.evidence?.affected_files).map((item) => trimText(item, 240)),
    files_match_canonical: summary.evidence?.files_match_canonical === true,
    commit_reachable: summary.evidence?.commit_reachable === true,
    diff_empty: summary.evidence?.diff_empty === true,
    verification_passed: summary.evidence?.verification_passed === true,
    acceptance_passed: summary.evidence?.acceptance_passed === true,
    integration_satisfied: summary.evidence?.integration_satisfied === true,
    blockers: compactList(summary.blockers).map(compactFinding),
  };
}

function summarizeContract(contract = null) {
  if (!contract || typeof contract !== 'object') return null;
  return {
    id: contract.id || contract.contract_id || null,
    operation_kind: contract.intent?.operation_kind || contract.operation_kind || null,
    semantic_confidence: contract.intent?.semantic_confidence || null,
    requires_commit: typeof contract.requirements?.requires_commit === 'boolean' ? contract.requirements.requires_commit : null,
    required_verification: compactList(contract.requirements?.required_verification).map((item) => trimText(item, 180)),
    blocking_requirements: compactList(contract.blocking_requirements).map((item) => ({
      id: item?.id || null,
      description: trimText(item?.description || item?.message || item?.title || '', 220),
    })),
    auto_complete_when_blocking_requirements_pass: contract.completion_policy?.auto_complete_when_blocking_requirements_pass === true,
  };
}

function summarizeResult(result = null) {
  if (!result || typeof result !== 'object') return { status: 'missing', summary: null, commit: null, remote_head: null, tests: null };
  return {
    status: result.status || null,
    summary: trimText(result.summary || result.message || ''),
    commit: result.commit || null,
    remote_head: result.remote_head || null,
    tests: trimText(result.tests || ''),
    warnings: compactList(result.warnings).map((item) => trimText(item, 220)),
  };
}

function addExistingPath(paths, key, relPath, config = {}) {
  if (!relPath) return;
  const absPath = resolveWorkspacePath(config, relPath);
  if (absPath && existsSync(absPath)) paths[key] = relPath;
}

function reportPathsFromResult(result = {}, files = {}, config = {}) {
  const paths = {};
  addExistingPath(paths, 'result_md', files.result_md, config);
  addExistingPath(paths, 'acceptance_contract_json', files.acceptance_contract_json, config);
  const dir = files.dir || '';
  if (dir) addExistingPath(paths, 'result_json', `${dir}/result.json`, config);
  const verification = result?.verification || {};
  if (verification.report_path) paths.verification_report = verification.report_path;
  if (result?.verification_report_path) paths.verification_report = result.verification_report_path;
  if (result?.evidence_paths && typeof result.evidence_paths === 'object') {
    for (const [key, value] of Object.entries(result.evidence_paths)) {
      if (typeof value === 'string' && value) paths[key] = value;
    }
  }
  return Object.fromEntries(Object.entries(paths).filter(([, value]) => typeof value === 'string' && value && !value.includes('transcript') && !value.includes('context.bundle')));
}

function summarizeRunEvidence(result = {}, reportPaths = {}) {
  const evidencePaths = result?.evidence_paths && typeof result.evidence_paths === 'object' ? result.evidence_paths : {};
  const eventsJsonl = evidencePaths.events_jsonl || reportPaths.events_jsonl || null;
  const artifactKeys = Object.keys({ ...evidencePaths, ...reportPaths })
    .filter((key) => !key.includes('transcript') && !key.includes('context.bundle'))
    .sort();
  const displays = ['workflow', 'context', 'verification', 'acceptance', 'queue', 'card'];
  return {
    events_jsonl: eventsJsonl,
    artifact_keys: artifactKeys,
    displays,
    raw_evidence_readable: typeof eventsJsonl === 'string' && eventsJsonl.length > 0,
  };
}

function resolveWorkspacePath(config = {}, relPath = '') {
  if (!relPath) return null;
  if (relPath.startsWith('/')) return relPath;
  const root = config.defaultWorkspaceRoot || process.cwd();
  return resolve(root, relPath);
}

async function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function resolveTaskAndGoal({ store, task_id }) {
  const state = await store.load();
  ensureGoalState(state);
  const task = typeof store.findTaskById === 'function'
    ? await store.findTaskById(task_id)
    : state.tasks.find((item) => item.id === task_id) || null;
  if (!task) throw new Error(`task not found: ${task_id}`);
  const goal = (task.goal_id && state.goals.find((item) => item.id === task.goal_id))
    || (typeof store.findGoalByTaskId === 'function' ? store.findGoalByTaskId(task.id) : null)
    || state.goals.find((item) => item.task_id === task.id)
    || null;
  return { task, goal };
}

function collectMissingEvidence({ task, result, verification, contractVerification, reportPaths }) {
  const missing = [];
  if (!result) missing.push({ code: 'result_missing', message: 'No structured task result or result.json is available yet.' });
  if (!verification || verification.status === 'missing' || verification.passed === null) {
    missing.push({ code: 'verification_missing', message: 'No verification evidence with a passed/failed decision is available yet.' });
  }
  if (TERMINAL_OR_REVIEW.has(task.status) && !contractVerification) {
    missing.push({ code: 'contract_verification_missing', message: 'No contract_verification evidence is available for this terminal or review task.' });
  }
  const reportEvidenceKeys = Object.keys(reportPaths || {}).filter((key) => key !== 'acceptance_contract_json');
  if (TERMINAL_OR_REVIEW.has(task.status) && reportEvidenceKeys.length === 0) {
    missing.push({ code: 'report_missing', message: 'No compact report paths are available for this task.' });
  }
  return missing;
}

function isResolvedOperationalFinding(finding = {}, result = {}) {
  if (finding?.code !== 'auto_integration_completion_failed') return false;
  const message = String(finding?.message || finding?.reason || '');
  if (!message.includes('Canonical repo ' + 'is dirty')) return false;
  return result?.verification?.passed === true && Boolean(result?.commit);
}

export async function getTaskAcceptanceBundle({ store, config = {}, task_id } = {}) {
  if (!store) throw new Error('store is required');
  if (!task_id) throw new Error('task_id is required');

  const { task, goal } = await resolveTaskAndGoal({ store, task_id });
  const files = goal ? goalWorkspaceFiles(goal) : {};
  const resultJsonPath = files.dir ? resolveWorkspacePath(config, join(files.dir, 'result.json')) : null;
  const contractJsonPath = files.acceptance_contract_json ? resolveWorkspacePath(config, files.acceptance_contract_json) : null;
  const fileResult = await readJsonIfExists(resultJsonPath);
  const fileContract = await readJsonIfExists(contractJsonPath);
  const result = task.result && typeof task.result === 'object' ? task.result : fileResult;
  const contract = goal?.acceptance_contract || result?.acceptance_contract || fileContract;
  const verification = compactVerification(result?.verification || null);
  const contractVerification = compactContractVerification(result?.contract_verification || null);
  const reportPaths = reportPathsFromResult(result || {}, files, config);
  const rawBlockers = [
    ...compactList(contractVerification?.blockers).map(compactFinding),
    ...compactList(result?.acceptance_findings).filter((finding) => ['blocker', 'major'].includes(finding?.severity)).map(compactFinding),
  ];
  const blockers = rawBlockers.filter((finding) => !isResolvedOperationalFinding(finding, result || {}));
  const nonBlockingFollowups = [
    ...compactList(contractVerification?.non_blocking_followups).map(compactFinding),
    ...compactList(result?.followups).map(compactFinding),
    ...compactList(result?.next_tasks).filter((item) => item?.severity === 'non_blocking' || item?.severity === 'followup').map(compactFinding),
  ].slice(0, MAX_ITEMS);
  const missingEvidence = collectMissingEvidence({ task, result, verification, contractVerification, reportPaths });

  return {
    task_id: task.id,
    goal_id: goal?.id || task.goal_id || null,
    title: task.title || goal?.title || null,
    status: task.status || null,
    operation_kind: result?.operation_kind || contract?.intent?.operation_kind || contract?.operation_kind || null,
    acceptance_contract_summary: summarizeContract(contract),
    result_summary: summarizeResult(result),
    verification,
    contract_verification: contractVerification,
    no_change_repair_completion_summary: compactNoChangeRepair(result?.no_change_repair_completion_summary || null),
    unified_decision: result?.unified_decision || null,
    closure_decision: compactClosureDecision(result?.closure_decision || null),
    integration: compactIntegration(result?.integration || null),
    changed_files: compactList(result?.changed_files || task.changed_files).map((item) => trimText(item, 240)),
    report_paths: reportPaths,
    run_evidence: summarizeRunEvidence(result || {}, reportPaths),
    blockers,
    non_blocking_followups: nonBlockingFollowups,
    quality_notes: compactList(contractVerification?.quality_notes || result?.quality_notes).map((note) => trimText(note, 240)),
    missing_evidence: missingEvidence,
  };
}
