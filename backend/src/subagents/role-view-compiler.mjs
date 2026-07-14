// @ts-check
/**
 * Role View Compiler — compiles role-scoped execution views from
 * task context and other sources.
 */

const ROLE_POLICIES = Object.freeze({
  context_curator: {
    role_kind: "canonical",
    include: ["objective", "background", "confirmed_findings", "scope", "constraints", "acceptance_criteria", "open_questions", "workstream_decisions"],
    write_product_code: false,
    run_commands: true,
  },
  explorer: {
    role_kind: "advisory",
    include: ["objective", "background", "confirmed_findings", "scope", "open_questions"],
    write_product_code: false,
    run_commands: true,
  },
  architect: {
    role_kind: "advisory",
    include: ["objective", "scope", "constraints", "workstream_decisions", "explorer_artifact"],
    write_product_code: false,
    run_commands: false,
  },
  test_analyst: {
    role_kind: "advisory",
    include: ["objective", "acceptance_criteria", "scope", "explorer_artifact", "architect_artifact"],
    write_product_code: false,
    run_commands: true,
  },
  planner: {
    role_kind: "canonical",
    include: ["objective", "scope", "constraints", "acceptance_criteria", "advisory_artifacts"],
    write_product_code: false,
    run_commands: true,
  },
  builder: {
    role_kind: "canonical",
    include: ["objective", "scope", "constraints", "acceptance_criteria", "formal_plan", "workstream_decisions"],
    write_product_code: true,
    run_commands: true,
  },
  verifier: {
    role_kind: "canonical",
    include: ["acceptance_criteria", "verification_plan", "changed_files", "expected_head"],
    write_product_code: false,
    run_commands: true,
  },
  reviewer: {
    role_kind: "canonical",
    include: ["objective", "scope", "acceptance_criteria", "architecture_boundaries", "change_summary", "verification", "machine_blockers", "expected_head"],
    write_product_code: false,
    run_commands: true,
  },
  repairer: {
    role_kind: "recovery",
    include: ["unresolved_blockers", "failed_commands", "allowed_scope", "current_head", "repair_round"],
    write_product_code: true,
    run_commands: true,
  },
  finalizer: {
    role_kind: "canonical",
    include: ["context_digest", "current_head", "freshness", "verification", "reviewer_decision", "contract_verification", "integration_requirement"],
    write_product_code: false,
    run_commands: false,
  },
});

/**
 * Compile a role-scoped view from the available sources.
 * @param {object} options
 * @param {string} options.role
 * @param {string} [options.taskContextDigest]
 * @param {object} [options.sources]
 * @returns {object}
 */
export function compileRoleView({ role, taskContextDigest, sources = {} }) {
  const policy = ROLE_POLICIES[role];
  if (!policy) {
    throw new Error(`unknown role view: ${role}`);
  }

  const payload = {};
  for (const key of policy.include) {
    if (sources[key] !== undefined) {
      payload[key] = sources[key];
    }
  }

  return {
    schema_version: "gptwork.role_view.v1",
    role,
    role_kind: policy.role_kind,
    task_context_digest: taskContextDigest || null,
    included_sections: Object.keys(payload),
    excluded_sources: [
      "raw_chatgpt_transcript",
      "tui_terminal_log",
      "unrelated_workstream_history",
    ],
    permissions: {
      read_repo: true,
      write_product_code: policy.write_product_code,
      run_commands: policy.run_commands,
    },
    payload,
  };
}

/**
 * Get the list of canonical (blocking) roles.
 * @returns {string[]}
 */
export function getCanonicalRoles() {
  return Object.entries(ROLE_POLICIES)
    .filter(([, p]) => p.role_kind === "canonical")
    .map(([name]) => name);
}

/**
 * Get the list of advisory (non-blocking) roles.
 * @returns {string[]}
 */
export function getAdvisoryRoles() {
  return Object.entries(ROLE_POLICIES)
    .filter(([, p]) => p.role_kind === "advisory")
    .map(([name]) => name);
}
