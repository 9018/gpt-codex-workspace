const ROLE_ALIASES = {
  'escalation_judgment': 'escalation_judge',
  'escalation-judge': 'escalation_judge',
  'escalation-judgment': 'escalation_judge',
};

/**
 * Normalize a role name to its canonical form if a known alias exists.
 * Unknown roles pass through unchanged, preserving strict validation.
 *
 * @param {string} name - The role name to normalize
 * @returns {string} The canonical role name, or the original if unknown
 */
export function normalizeRoleName(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim().toLowerCase();
  return ROLE_ALIASES[trimmed] || name;
}

// ---------------------------------------------------------------------------
// Runtime code change detection (P0 hotfix: safe-restart gating)
// ---------------------------------------------------------------------------

/**
 * Runtime server file patterns -- files loaded by the running gptwork-mcp.service.
 * Changes to these files require a safe restart to take effect.
 * Matches any .mjs file under backend/src/.
 */
const RUNTIME_SRC_PATTERNS = [
  /^backend\/src\/.*\.mjs$/,
];

/**
 * Check if a list of changed files contains any runtime server source files.
 * This is used to gate deploy-mode tasks: if runtime code was changed,
 * a safe restart must be scheduled before the task can complete.
 *
 * @param {string[]} changedFiles - Array of file paths from result.changed_files
 * @returns {{ hasRuntimeChanges: boolean, matchedFiles: string[] }}
 */
export function detectRuntimeCodeChanges(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { hasRuntimeChanges: false, matchedFiles: [] };
  }
  const matchedFiles = changedFiles.filter(f =>
    RUNTIME_SRC_PATTERNS.some(pattern => pattern.test(f))
  );
  return {
    hasRuntimeChanges: matchedFiles.length > 0,
    matchedFiles
  };
}

/**
 * Validate that a Codex result.json satisfies the goal's autonomy/subagent policy.
 *
 * @param {object} result - Parsed result object from parseResultJson or parseCodexResult.
 * @param {object} [goal] - Goal object with optional autonomy_policy and subagent_policy.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateAutonomyResult(result, goal) {
  const autonomy = goal?.autonomy_policy || {};
  const subagent = goal?.subagent_policy || {};

  // Budget check applies regardless of mode
  const budget = autonomy.gpt_question_budget ?? 0;
  const used = result.gpt_questions_used ?? 0;
  if (used > budget) {
    return { valid: false, reason: 'gpt_question_budget_exceeded' };
  }

  // If subagent_policy mode is not 'required', no further validation needed
  if (subagent.mode !== 'required') {
    return { valid: true };
  }

  // --- Strict subagent policy validation below ---

  // 1. subagents_used must be true
  if (result.subagents_used !== true) {
    return { valid: false, reason: 'subagents_required_but_not_used' };
  }

  // 2. subagents must be a non-empty array
  if (!Array.isArray(result.subagents)) {
    return { valid: false, reason: 'missing_subagent_report' };
  }
  if (result.subagents.length === 0) {
    return { valid: false, reason: 'empty_subagents' };
  }

  // 3. Each subagent entry must have non-empty role, status, summary
  for (let i = 0; i < result.subagents.length; i++) {
    const entry = result.subagents[i];
    if (!entry || typeof entry !== 'object') {
      return { valid: false, reason: 'malformed_subagent_entry_at_' + i };
    }
    if (!entry.role || typeof entry.role !== 'string' || entry.role.trim() === '') {
      return { valid: false, reason: 'subagent_missing_role_at_' + i };
    }
    if (!entry.status || typeof entry.status !== 'string' || entry.status.trim() === '') {
      return { valid: false, reason: 'subagent_missing_status_at_' + i };
    }
    if (!entry.summary || typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      return { valid: false, reason: 'subagent_missing_summary_at_' + i };
    }
    // 4. Subagent status must be 'completed' for roles used as completion evidence
    if (entry.status !== 'completed') {
      return { valid: false, reason: 'subagent_not_completed_' + entry.role };
    }
  }

  // 5. If subagent_policy.roles is a non-empty array, require all policy roles present
  if (Array.isArray(subagent.roles) && subagent.roles.length > 0) {
    const providedRoles = new Set(result.subagents.map(s => normalizeRoleName(s.role)));
    const decisionLog = Array.isArray(result.decision_log) ? result.decision_log : [];

    for (const requiredRole of subagent.roles) {
      if (providedRoles.has(requiredRole)) continue;

      // Check decision_log for role equivalence mapping
      const equivalenceEntry = decisionLog.find(e =>
        e && typeof e === 'object' &&
        (
          (e.mapped_roles && Array.isArray(e.mapped_roles) &&
           e.mapped_roles.some(m => m.policy_role === requiredRole && (providedRoles.has(m.provided_role) || providedRoles.has(normalizeRoleName(m.provided_role))))) ||
          (e.role_equivalence && Array.isArray(e.role_equivalence) &&
           e.role_equivalence.some(m => m.policy_role === requiredRole && (providedRoles.has(m.provided_role) || providedRoles.has(normalizeRoleName(m.provided_role))))) ||
          (e.equivalent_roles && Array.isArray(e.equivalent_roles) &&
           e.equivalent_roles.some(m => m.policy_role === requiredRole && (providedRoles.has(m.provided_role) || providedRoles.has(normalizeRoleName(m.provided_role)))))
        )
      );
      if (equivalenceEntry) continue;

      // Check decision_log for a general 'all roles covered' statement
      const allCoveredEntry = decisionLog.find(e =>
        e && typeof e === 'object' &&
        (e.all_roles_covered === true || e.roles_covered === true)
      );
      if (allCoveredEntry) continue;

      return { valid: false, reason: 'missing_required_role_' + requiredRole };
    }
  }

  // 6. If require_review_before_completion, require a reviewer role or equivalent
  if (subagent.require_review_before_completion === true) {
    const reviewRoles = ['reviewer', 'review', 'code_reviewer', 'qa_reviewer'];
    const hasReviewer = result.subagents.some(s =>
      reviewRoles.includes(s.role) && s.status === 'completed'
    );
    if (!hasReviewer) {
      return { valid: false, reason: 'missing_review_subagent' };
    }
  }

  // 7. If require_test_or_verification, require tester/verification subagent or verification.passed
  if (subagent.require_test_or_verification === true) {
    const testRoles = ['tester', 'test', 'verification', 'qa', 'quality_assurance'];
    const hasTester = result.subagents.some(s =>
      testRoles.includes(s.role) && s.status === 'completed'
    );
    const verificationPassed = result.verification && result.verification.passed === true;
    if (!hasTester && !verificationPassed) {
      return { valid: false, reason: 'missing_test_or_verification' };
    }
  }

  return { valid: true };
}
