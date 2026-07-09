import { ACCEPTANCE_CONTRACT_SCHEMA_VERSION, DEFAULT_COMPLETION_POLICY, cloneJson } from "./contract-schema.mjs";

const QUALITY_EXPECTATIONS = Object.freeze([
  { id: "quality_notes_as_followups", description: "Report non-blocking quality concerns as followup_findings instead of blocking closure." },
  { id: "minimal_reversible_increment", description: "Prefer the smallest reversible increment that satisfies blocking requirements." }
]);

function req(id, description, evidence = []) {
  return { id, description, evidence };
}

function assertion(id, description) {
  return { id, description };
}

function profile({ intent, requirements, verification_plan, blocking_requirements, state_assertions = [], non_blocking_quality_expectations = QUALITY_EXPECTATIONS, review_policy = { requires_review_when: [] } }) {
  return Object.freeze({
    schema_version: ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    intent,
    requirements,
    blocking_requirements,
    verification_plan: {
      profile: "changed",
      fallback_profile: "fast",
      required_commands: [],
      required_reports: [],
      report_must_match_head: true,
      report_must_be_clean: true,
      ...verification_plan
    },
    state_assertions,
    non_blocking_quality_expectations,
    completion_policy: DEFAULT_COMPLETION_POLICY,
    review_policy
  });
}

export const ACCEPTANCE_CONTRACT_PROFILES = Object.freeze({
  code_change: profile({
    intent: { operation_kind: "code_change", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: true, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "changed", fallback_profile: "fast", required_reports: ["verification_report", "changed_files"] },
    blocking_requirements: [
      req("commit_present", "A commit hash for the implemented increment is reported.", ["commit"]),
      req("changed_files_reported", "Changed files are reported and attributable to the task.", ["changed_files"]),
      req("verification_report", "Relevant verification commands or a release report are provided.", ["verification.commands", "tests"]),
      req("integration_completed", "Required local integration or ff-only handoff is completed when applicable.", ["integration", "remote_head"])
    ]
  }),
  file_write: profile({
    intent: { operation_kind: "file_write", mutation_scope: "filesystem", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: true, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "changed", fallback_profile: "fast", required_reports: ["file_path", "checksum", "diff", "commit"] },
    blocking_requirements: [
      req("file_exists", "The expected file path exists after the task.", ["path"]),
      req("file_checksum", "A checksum or equivalent content evidence is reported.", ["checksum"]),
      req("diff_reported", "The file diff or summary is reported.", ["diff", "changed_files"]),
      req("commit_present", "A commit hash for the file write is reported.", ["commit"]),
      req("integration_completed", "Required local integration or ff-only handoff is completed when applicable.", ["integration", "remote_head"])
    ]
  }),
  docs_only: profile({
    intent: { operation_kind: "docs_only", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    // Docs-only tasks are repository mutations, but they do not require the
    // integration pipeline to prove product safety. Their closure evidence is
    // commit + changed docs + lightweight docs/syntax verification. Requiring
    // integration here creates false waiting_for_review blockers for docs
    // regression sync tasks that are already committed and verified.
    requirements: { requires_commit: true, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "docs", fallback_profile: "changed", required_commands: ["docs_check"], required_reports: ["changed_files", "commit"] },
    blocking_requirements: [
      req("docs_changed", "Documentation-only files changed as requested.", ["changed_files"]),
      req("commit_present", "A commit hash for the documentation update is reported.", ["commit"]),
      req("docs_verification", "A lightweight docs verification or rationale is reported.", ["tests", "verification.commands"])
    ]
  }),
  config_change: profile({
    intent: { operation_kind: "config_change", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: true, requires_restart: true, requires_deployment_check: false },
    verification_plan: { profile: "config", fallback_profile: "fast", required_reports: ["config_parse", "reload_or_restart", "health_check"] },
    blocking_requirements: [
      req("config_parse", "Configuration parses or validates successfully.", ["config_parse"]),
      req("reload_or_restart_evidence", "Reload/restart need is handled or explicitly ruled out.", ["reload", "restart"]),
      req("runtime_health_evidence", "Runtime health after config application is reported when applicable.", ["health_check"]),
      req("commit_present", "A commit hash is reported for repo configuration changes.", ["commit"])
    ]
  }),
  restart: profile({
    intent: { operation_kind: "restart", mutation_scope: "runtime", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: true, requires_deployment_check: false },
    verification_plan: { profile: "runtime", fallback_profile: "diagnostic", required_reports: ["process_status", "health_check", "runtime_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("restart_performed", "The restart action or safe scheduled restart is reported.", ["restart"]),
      req("process_status_evidence", "Process status before/after restart is reported.", ["process_status"]),
      req("runtime_health_evidence", "Runtime health evidence is reported after restart.", ["health_check"])
    ]
  }),
  deploy: profile({
    intent: { operation_kind: "deploy", mutation_scope: "runtime", execution_mode: "deploy", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: true },
    verification_plan: { profile: "deploy", fallback_profile: "runtime", required_reports: ["build", "start", "port", "health_check", "runtime_version"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("build_evidence", "Build or deploy preparation completed successfully.", ["build"]),
      req("service_started", "The deployed service was started or confirmed running.", ["start", "process_status"]),
      req("port_evidence", "Service port or endpoint is reported.", ["port", "endpoint"]),
      req("deployment_health", "Deployment health check evidence is reported.", ["health_check"]),
      req("runtime_version_evidence", "Runtime version, image, commit, or release identifier is reported.", ["runtime_version", "image", "release"])
    ]
  }),
  admin_command: profile({
    intent: { operation_kind: "admin_command", mutation_scope: "runtime", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "admin", fallback_profile: "diagnostic", required_reports: ["pre_state_snapshot", "command_result", "post_state_snapshot", "audit_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("pre_state_snapshot", "Pre-command state is captured.", ["pre_state"]),
      req("command_result", "Command and exit/result evidence are reported.", ["command", "exit_code"]),
      req("post_state_snapshot", "Post-command state is captured.", ["post_state"]),
      req("audit_evidence", "Audit trail or command rationale is reported.", ["audit"])
    ]
  }),
  diagnostic: profile({
    intent: { operation_kind: "diagnostic", mutation_scope: "none", execution_mode: "readonly", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "diagnostic", fallback_profile: "readonly", required_reports: ["diagnostic_report", "no_mutation_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("diagnostic_report", "A diagnostic report with findings and evidence is produced.", ["report"]),
      req("no_mutation_evidence", "The result states no mutation was performed or identifies any accidental mutation.", ["no_mutation"])
    ]
  }),
  cleanup: profile({
    intent: { operation_kind: "cleanup", mutation_scope: "filesystem", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "cleanup", fallback_profile: "admin", required_reports: ["dry_run", "apply", "before_after_counts", "audit_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("dry_run_evidence", "Dry-run output is reported before destructive cleanup.", ["dry_run"]),
      req("apply_evidence", "Cleanup application output is reported.", ["apply"]),
      req("before_after_counts", "Before/after counts are reported.", ["before_count", "after_count"]),
      req("active_items_preserved", "Active items were preserved or explicitly exempted.", ["preserved"]),
      req("audit_evidence", "Cleanup audit evidence is reported.", ["audit"])
    ]
  }),
  external_sync: profile({
    intent: { operation_kind: "external_sync", mutation_scope: "external_system", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "external_sync", fallback_profile: "admin", required_reports: ["sync_before", "sync_after", "audit_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("sync_before_state", "External state before sync is reported.", ["before"]),
      req("sync_after_state", "External state after sync is reported.", ["after"]),
      req("audit_evidence", "Sync audit evidence is reported.", ["audit"])
    ]
  }),
  data_migration: profile({
    intent: { operation_kind: "data_migration", mutation_scope: "external_system", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "migration", fallback_profile: "requires_review", required_reports: ["backup", "dry_run", "apply", "counts", "rollback_plan"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("backup_evidence", "Backup or restore point evidence is reported.", ["backup"]),
      req("dry_run_evidence", "Dry-run or migration preview is reported.", ["dry_run"]),
      req("migration_apply_evidence", "Migration application evidence is reported.", ["apply"]),
      req("before_after_counts", "Before/after counts are reported.", ["before_count", "after_count"]),
      req("rollback_plan", "Rollback plan or explicit review fallback is reported.", ["rollback"])
    ],
    review_policy: { requires_review_when: ["migration_risk_unresolved"] }
  }),
  noop: profile({
    intent: { operation_kind: "noop", mutation_scope: "none", execution_mode: "readonly", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "noop", fallback_profile: "diagnostic", required_reports: ["noop_reason", "no_mutation_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("noop_reason", "The reason no action was required is reported.", ["reason"]),
      req("no_mutation_evidence", "No mutation evidence is reported.", ["no_mutation"])
    ],
    state_assertions: [assertion("no_mutation", "No repository, runtime, filesystem, or external state mutation occurred.")]
  }),
  readonly_validation: profile({
    intent: { operation_kind: "readonly_validation", mutation_scope: "none", execution_mode: "readonly", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "diagnostic", fallback_profile: "readonly", required_reports: ["validation_report", "no_mutation_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("validation_report", "A validation report with findings and evidence is produced.", ["report"]),
      req("no_mutation_evidence", "The result states no mutation was performed or identifies any accidental mutation.", ["no_mutation"])
    ]
  }),
  already_integrated: profile({
    intent: { operation_kind: "already_integrated", mutation_scope: "none", execution_mode: "readonly", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "noop", fallback_profile: "diagnostic", required_reports: ["integration_evidence", "no_mutation_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("integration_evidence", "Evidence that the change was already integrated is reported.", ["already_integrated_evidence"]),
      req("no_mutation_evidence", "No mutation evidence is reported.", ["no_mutation"])
    ],
    state_assertions: [assertion("no_mutation", "No repository, runtime, filesystem, or external state mutation occurred.")]
  }),
  integration: profile({
    intent: { operation_kind: "integration", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "changed", fallback_profile: "fast", required_reports: ["commit", "changed_files", "verification_report"] },
    blocking_requirements: [
      req("commit_present", "A commit hash for the integrated increment is reported.", ["commit"]),
      req("changed_files_reported", "Changed files are reported and attributable to the integration.", ["changed_files"]),
      req("verification_report", "Integration verification commands are provided.", ["verification.commands", "tests"])
    ]
  }),
  repair: profile({
    intent: { operation_kind: "repair", mutation_scope: "repo", execution_mode: "worktree", semantic_confidence: "high" },
    requirements: { requires_commit: true, requires_integration: true, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "changed", fallback_profile: "fast", required_reports: ["verification_report", "changed_files", "repair_evidence"] },
    blocking_requirements: [
      req("repair_evidence", "The repair outcome or rationale is reported.", ["repair_marker"]),
      req("commit_present", "A commit hash for the repair increment is reported.", ["commit"]),
      req("changed_files_reported", "Changed files are reported and attributable to the repair.", ["changed_files"]),
      req("verification_report", "Verification commands for the repair are provided.", ["verification.commands", "tests"]),
      req("integration_completed", "Required local integration or ff-only handoff is completed when applicable.", ["integration", "remote_head"])
    ]
  }),
  queue_admin: profile({
    intent: { operation_kind: "queue_admin", mutation_scope: "runtime", execution_mode: "admin", semantic_confidence: "high" },
    requirements: { requires_commit: false, requires_integration: false, requires_restart: false, requires_deployment_check: false },
    verification_plan: { profile: "admin", fallback_profile: "diagnostic", required_reports: ["pre_state_snapshot", "queue_operation", "post_state_snapshot", "audit_evidence"], report_must_match_head: false, report_must_be_clean: false },
    blocking_requirements: [
      req("pre_state_snapshot", "Pre-queue-admin state is captured.", ["pre_state"]),
      req("queue_operation_result", "Queue operation and exit/result evidence are reported.", ["command", "exit_code"]),
      req("post_state_snapshot", "Post-queue-admin state is captured.", ["post_state"]),
      req("audit_evidence", "Queue admin audit evidence is reported.", ["audit"])
    ]
  }),

});

export function getDefaultAcceptanceContractProfile(operationKind) {
  const profile = ACCEPTANCE_CONTRACT_PROFILES[operationKind] || ACCEPTANCE_CONTRACT_PROFILES.noop;
  return cloneJson(profile);
}
