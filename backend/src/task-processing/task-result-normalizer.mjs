import { CODEX_EXECUTION_PROVIDERS } from "../codex-execution-provider.mjs";

function isVerifiedNoChangeResult(result = {}) {
  const nonMutatingOps = ["readonly_validation", "noop", "already_integrated", "diagnostic"];
  if (nonMutatingOps.includes(result.operation_kind)) return result?.status === "completed";
  return result?.status === "completed"
    && Array.isArray(result.changed_files)
    && result.changed_files.length === 0
    && !result.commit
    && result.verification?.passed === true;
}

export function applyLegacyNoChangeCompatibility(result = {}) {
  if (!isVerifiedNoChangeResult(result)) return result;
  const nonMutatingOps = ["readonly_validation", "noop", "already_integrated", "diagnostic"];
  if (!nonMutatingOps.includes(result.operation_kind)) {
    result.noop = true;
    result.noop_reason ||= "No changed files were reported and verification passed.";
    result.operation_kind ||= "noop";
  }
  result.no_mutation = true;
  result.repo_mutated = false;
  return result;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function normalizeCommitEvidence(value) {
  if (value === undefined || value === null) return "none";
  const commit = String(value).trim();
  return commit && commit !== "null" ? commit : "none";
}

function normalizeTuiVerification({ resultJson, snapshot, findings, status, tests }) {
  const rawVerification = asPlainObject(resultJson.verification);
  const commands = Array.isArray(rawVerification.commands)
    ? rawVerification.commands
    : (tests && tests !== "none" ? [{ cmd: String(tests), exit_code: 0, passed: true }] : []);
  const hasBlockingFinding = findings.some((finding) => ["blocker", "major"].includes(finding?.severity));
  const worktreeClean = snapshot.worktree_clean !== false;
  const hasPassingEvidence = rawVerification.passed === true
    || (rawVerification.passed !== false && status === "completed" && commands.length > 0);
  return {
    ...rawVerification,
    passed: hasPassingEvidence && !hasBlockingFinding && worktreeClean,
    commands,
    findings,
  };
}

export function normalizeTuiEvidenceToTaskResult(collected, task = {}, goal = {}, session = {}) {
  const cycle = asPlainObject(collected);
  const snapshot = asPlainObject(cycle.collected || cycle.completion || {});
  const resultJson = asPlainObject(cycle.result_json || snapshot.result_json);
  const findings = [
    ...asList(resultJson.acceptance_findings),
    ...asList(resultJson.findings),
    ...asList(snapshot.findings),
    cycle.finding,
  ].filter(Boolean);
  const changedFiles = asList(resultJson.changed_files).length > 0
    ? asList(resultJson.changed_files)
    : asList(snapshot.changed_files);
  const commit = normalizeCommitEvidence(resultJson.commit ?? snapshot.commit);
  const verificationCommands = Array.isArray(resultJson.verification?.commands)
    ? resultJson.verification.commands
    : [];
  const tests = resultJson.tests
    || snapshot.tests
    || (verificationCommands.length > 0 ? verificationCommands.map((command) => command.cmd || command.command || String(command)).join("; ") : null);
  const status = ["completed", "failed", "timed_out"].includes(resultJson.status)
    ? resultJson.status
    : "completed";
  const verification = normalizeTuiVerification({ resultJson, snapshot, findings, status, tests });
  const operationKind = resultJson.operation_kind || (changedFiles.length > 0 ? "code_change" : "diagnostic");
  const integrationNotRequired = resultJson.integration_not_required ?? (changedFiles.length === 0);

  return {
    ...resultJson,
    kind: status === "timed_out" ? "codex_timeout" : status === "failed" ? "codex_failed" : "codex_executed",
    status,
    structured: true,
    from_json: true,
    summary: resultJson.summary || snapshot.summary || `Codex TUI session ${session.id || cycle.session_id || "unknown"} completed`,
    changed_files: changedFiles,
    tests: tests || null,
    commit,
    remote_head: resultJson.remote_head || "none",
    warnings: asList(resultJson.warnings),
    followups: asList(resultJson.followups),
    acceptance_findings: findings,
    verification,
    operation_kind: operationKind,
    integration_not_required: integrationNotRequired,
    integration: asPlainObject(resultJson.integration),
    provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    codex_execution_provider: CODEX_EXECUTION_PROVIDERS.TUI_GOAL,
    execution_backend: "codex_tui_superpowers",
    execution_backend_role: "operator",
    session_id: session.id || cycle.session_id || snapshot.session_id || null,
    tui_phase: "evidence_ready",
    result_json_path: snapshot.result_json_path || resultJson.result_json_path || null,
    result_md_present: snapshot.result_md_present === true || resultJson.result_md_present === true,
    worktree_clean: snapshot.worktree_clean !== false,
    completed_at: resultJson.completed_at || new Date().toISOString(),
  };
}
