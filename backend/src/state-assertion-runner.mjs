import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { normalizeList } from './acceptance-contract-schema.mjs';
import { healthPassed, integrationSatisfied } from './operation-evidence-profiles.mjs';

const execFileAsync = promisify(execFile);

function assertionKind(assertion = {}) {
  return String(assertion.kind || assertion.id || '').trim();
}

function resultPath(path, repoPath, workspaceRoot) {
  if (!path) return null;
  const raw = String(path);
  if (isAbsolute(raw)) return raw;
  return join(repoPath || workspaceRoot || process.cwd(), raw);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function git(repoPath, args, config = {}) {
  if (!repoPath) return null;
  if (args[0] === 'status' && config.repoStatusPorcelain !== undefined) return String(config.repoStatusPorcelain);
  if (args[0] === 'rev-parse' && config.repoHead !== undefined) return String(config.repoHead);
  if (args[0] === 'merge-base' && config.commitReachable !== undefined) return config.commitReachable ? 'reachable' : null;
  try {
    const result = await execFileAsync('git', args, { cwd: repoPath, timeout: 15_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function verificationReportPath(result = {}) {
  return result.verification?.report_path || result.verification_report_path || result.evidence_paths?.verification_report || null;
}

async function readReport(result, repoPath, workspaceRoot) {
  const path = resultPath(verificationReportPath(result), repoPath, workspaceRoot);
  if (!path) return { path: null, report: null, error: 'missing_report_path' };
  try {
    return { path, report: JSON.parse(await readFile(path, 'utf8')), error: null };
  } catch (err) {
    return { path, report: null, error: err?.message || String(err) };
  }
}

function adminEvidence(result = {}) {
  return result.admin_evidence || {};
}

function cleanupEvidence(result = {}) {
  return result.cleanup_evidence || {};
}

function restartEvidence(result = {}) {
  return result.restart_evidence || {};
}

function diagnosticEvidence(result = {}) {
  return result.diagnostic_evidence || {};
}

function pass(kind, evidence = {}) {
  return { kind, passed: true, evidence };
}

function fail(kind, evidence = {}) {
  return { kind, passed: false, evidence };
}

async function evaluateAssertion({ assertion, result, repoPath, workspaceRoot, runtimeContext, config }) {
  const kind = assertionKind(assertion);
  switch (kind) {
    case 'repo_clean': {
      const status = await git(repoPath, ['status', '--porcelain'], config);
      return status === '' ? pass(kind, { status }) : fail(kind, { status });
    }
    case 'file_exists': {
      const path = resultPath(assertion.path || assertion.file || result.file_evidence?.[0]?.path, repoPath, workspaceRoot);
      return (path && await pathExists(path)) ? pass(kind, { path }) : fail(kind, { path });
    }
    case 'file_min_bytes': {
      const path = resultPath(assertion.path || assertion.file || result.file_evidence?.[0]?.path, repoPath, workspaceRoot);
      const minBytes = Number(assertion.min_bytes ?? assertion.minBytes ?? 1);
      try {
        const info = await stat(path);
        return info.size >= minBytes ? pass(kind, { path, bytes: info.size, min_bytes: minBytes }) : fail(kind, { path, bytes: info.size, min_bytes: minBytes });
      } catch (err) {
        return fail(kind, { path, error: err?.message || String(err) });
      }
    }
    case 'file_sha256_matches': {
      const path = resultPath(assertion.path || assertion.file || result.file_evidence?.[0]?.path, repoPath, workspaceRoot);
      const expected = assertion.sha256 || result.file_evidence?.find((item) => item.path === assertion.path)?.sha256 || result.file_evidence?.[0]?.sha256;
      try {
        const actual = await fileSha256(path);
        return actual === expected ? pass(kind, { path, sha256: actual }) : fail(kind, { path, expected_sha256: expected, actual_sha256: actual });
      } catch (err) {
        return fail(kind, { path, expected_sha256: expected, error: err?.message || String(err) });
      }
    }
    case 'result_has_changed_files':
      return normalizeList(result.changed_files).length > 0 ? pass(kind, { changed_files: result.changed_files }) : fail(kind, { changed_files: [] });
    case 'commit_present':
      return result.commit ? pass(kind, { commit: result.commit }) : fail(kind, { commit: null });
    case 'commit_reachable': {
      if (!result.commit) return fail(kind, { commit: null });
      const reachable = await git(repoPath, ['merge-base', '--is-ancestor', result.commit, 'HEAD'], config);
      if (config.commitReachable === true || reachable !== null) return pass(kind, { commit: result.commit });
      return fail(kind, { commit: result.commit });
    }
    case 'integration_satisfied':
      return integrationSatisfied(result) ? pass(kind, { integration: result.integration || null }) : fail(kind, { integration: result.integration || null });
    case 'release_report_passed': {
      const { path, report, error } = await readReport(result, repoPath, workspaceRoot);
      return report?.passed === true ? pass(kind, { path }) : fail(kind, { path, error, passed: report?.passed });
    }
    case 'report_head_matches': {
      const { path, report, error } = await readReport(result, repoPath, workspaceRoot);
      const expected = config.repoHead || await git(repoPath, ['rev-parse', 'HEAD'], config) || result.commit || null;
      const actual = report?.repo?.head || null;
      return expected && actual === expected ? pass(kind, { path, head: actual }) : fail(kind, { path, error, expected_head: expected, report_head: actual });
    }
    case 'report_repo_clean': {
      const { path, report, error } = await readReport(result, repoPath, workspaceRoot);
      return report?.repo?.dirty === false ? pass(kind, { path, dirty: false }) : fail(kind, { path, error, dirty: report?.repo?.dirty });
    }
    case 'health_check_passed': {
      const health = restartEvidence(result).health_check || result.health_check || runtimeContext?.health_check;
      return healthPassed(health) ? pass(kind, { health_check: health }) : fail(kind, { health_check: health || null });
    }
    case 'runtime_commit_matches': {
      const evidence = restartEvidence(result);
      const matches = evidence.runtime_commit_matches === true || (evidence.expected_commit && evidence.expected_commit === evidence.running_commit);
      return matches ? pass(kind, { expected_commit: evidence.expected_commit, running_commit: evidence.running_commit }) : fail(kind, { expected_commit: evidence.expected_commit || null, running_commit: evidence.running_commit || null });
    }
    case 'process_restarted': {
      const evidence = restartEvidence(result);
      const restarted = evidence.pid_changed === true || (evidence.before_pid && evidence.after_pid && evidence.before_pid !== evidence.after_pid);
      return restarted ? pass(kind, { before_pid: evidence.before_pid, after_pid: evidence.after_pid }) : fail(kind, { before_pid: evidence.before_pid || null, after_pid: evidence.after_pid || null });
    }
    case 'port_listening': {
      const port = Number(assertion.port ?? result.port ?? result.health_check?.port);
      const ports = normalizeList(runtimeContext?.listeningPorts || runtimeContext?.listening_ports).map(Number);
      return ports.includes(port) ? pass(kind, { port }) : fail(kind, { port, listening_ports: ports });
    }
    case 'audit_log_written': {
      const written = adminEvidence(result).audit_log_written === true || cleanupEvidence(result).audit_log_written === true || result.audit_log_written === true;
      return written ? pass(kind, { audit_log_written: true }) : fail(kind, { audit_log_written: false });
    }
    case 'pre_post_state_delta_matches': {
      const evidence = adminEvidence(result);
      const ok = evidence.pre_state_snapshot !== undefined && evidence.post_state_snapshot !== undefined && evidence.state_delta !== undefined;
      return ok ? pass(kind, { state_delta: evidence.state_delta }) : fail(kind, { pre_state_snapshot: evidence.pre_state_snapshot ?? null, post_state_snapshot: evidence.post_state_snapshot ?? null, state_delta: evidence.state_delta ?? null });
    }
    case 'no_repo_mutation': {
      const status = await git(repoPath, ['status', '--porcelain'], config);
      const explicit = diagnosticEvidence(result).repo_mutated === false || result.repo_mutated === false || result.no_mutation === true;
      return explicit && status === '' ? pass(kind, { repo_mutated: false, status }) : fail(kind, { explicit_no_mutation: explicit, status });
    }
    case 'active_items_preserved':
      return cleanupEvidence(result).active_items_preserved === true ? pass(kind, { active_items_preserved: true }) : fail(kind, { active_items_preserved: false });
    default:
      return fail(kind || 'unknown', { unsupported: true, assertion });
  }
}

export async function runStateAssertions({ contract = {}, result = {}, repoPath = null, workspaceRoot = null, runtimeContext = {}, config = {} } = {}) {
  const assertions = [];
  for (const assertion of normalizeList(contract.state_assertions)) {
    assertions.push(await evaluateAssertion({ assertion, result, repoPath, workspaceRoot, runtimeContext, config }));
  }
  const failures = assertions.filter((assertion) => assertion.passed !== true);
  return { passed: failures.length === 0, assertions, failures };
}
