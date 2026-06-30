import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function splitCommand(command) {
  if (Array.isArray(command)) return command.map(String);
  if (command && typeof command === 'object') return [command.cmd, ...(command.args || [])].filter(Boolean).map(String);
  return String(command || '').trim().split(/\s+/).filter(Boolean);
}

function normalizeCommandParts(parts) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function commandFingerprint(command) {
  return normalizeCommandParts(splitCommand(command));
}

function stepFingerprints(step) {
  const base = commandFingerprint(step);
  const fingerprints = new Set([base]);
  if (basename(String(step?.cwd || '')) === 'backend' && base.startsWith('npm run ')) {
    fingerprints.add(base.replace(/^npm run /, 'npm --prefix backend run '));
  }
  return fingerprints;
}

function reportProfile(report) {
  return String(report?.profile || report?.mode || '').trim();
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value == null) return Date.now();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function completedAtMs(report) {
  const parsed = Date.parse(String(report?.completed_at || report?.completedAt || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function profileSatisfies(actual, required) {
  if (!required) return true;
  if (actual === required) return true;
  if (actual === 'fast' && (required === 'changed' || required === 'docs')) return true;
  if (actual === 'changed' && required === 'docs') return true;
  return false;
}

export async function readVerificationReport(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function isVerificationReportReusable(report, {
  repoHead,
  requiredCommands = [],
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  profile,
  now,
} = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { reusable: false, reason: 'invalid_report' };
  }
  const actualProfile = reportProfile(report);
  const reportHead = report?.repo?.head || null;
  if (report.passed !== true) return { reusable: false, reason: 'report_failed', profile: actualProfile, head: reportHead };
  if (repoHead && reportHead !== repoHead) {
    return { reusable: false, reason: 'head_mismatch', expected_head: repoHead, report_head: reportHead, profile: actualProfile, head: reportHead };
  }
  if (report?.repo?.dirty !== false) return { reusable: false, reason: 'repo_dirty', profile: actualProfile, head: reportHead };
  if (!profileSatisfies(actualProfile, profile)) {
    return { reusable: false, reason: 'profile_mismatch', expected_profile: profile, report_profile: actualProfile, profile: actualProfile, head: reportHead };
  }
  const completed = completedAtMs(report);
  if (maxAgeMs != null && completed == null) {
    return { reusable: false, reason: 'missing_completed_at', profile: actualProfile, head: reportHead };
  }
  if (maxAgeMs != null && nowMs(now) - completed > maxAgeMs) {
    return { reusable: false, reason: 'report_expired', completed_at: report.completed_at, max_age_ms: maxAgeMs, profile: actualProfile, head: reportHead };
  }

  const passedStepFingerprints = new Set();
  for (const step of Array.isArray(report.steps) ? report.steps : []) {
    if (step?.passed !== true && step?.exit_code !== 0) continue;
    for (const fingerprint of stepFingerprints(step)) passedStepFingerprints.add(fingerprint);
  }

  const requiredFingerprints = requiredCommands.map(commandFingerprint).filter(Boolean);
  const missing = requiredFingerprints.filter((fingerprint) => !passedStepFingerprints.has(fingerprint));
  if (missing.length > 0) {
    return { reusable: false, reason: 'missing_required_command', missing_commands: missing, profile: actualProfile, head: reportHead };
  }

  return {
    reusable: true,
    reason: 'reusable',
    profile: actualProfile,
    head: reportHead,
    matched_commands: requiredFingerprints,
  };
}

export function verificationReportToEvidence(report) {
  const commands = [];
  for (const step of Array.isArray(report?.steps) ? report.steps : []) {
    commands.push({
      cmd: commandFingerprint(step),
      exit_code: typeof step?.exit_code === 'number' ? step.exit_code : (step?.passed === true ? 0 : 1),
      stdout_tail: String(step?.stdout_tail || ''),
      stderr_tail: String(step?.stderr_tail || ''),
      reused: true,
      source: 'verification_report',
      name: step?.name || null,
      duration_ms: typeof step?.duration_ms === 'number' ? step.duration_ms : null,
    });
  }
  return { commands };
}

export function commandEvidenceFromReport(report, command) {
  const target = commandFingerprint(command);
  for (const step of Array.isArray(report?.steps) ? report.steps : []) {
    if (!stepFingerprints(step).has(target)) continue;
    const [evidence] = verificationReportToEvidence({ steps: [step] }).commands;
    return { ...evidence, cmd: target };
  }
  return null;
}
