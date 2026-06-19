/**
 * Codex result parser - extracts structured fields from Codex CLI output.
 *
 * Two parsing modes:
 *   1. result.json (preferred) - a JSON file written by Codex at the end of execution
 *   2. stdout structured fields (fallback) - STATUS=<...>, SUMMARY=<...>, etc.
 *
 * result.json contract:
 *   {
 *     "status": "completed" | "failed" | "timed_out",
 *     "summary": "string",
 *     "changed_files": ["file1.js", "file2.js"],
 *     "tests": "string describing test results",
 *     "commit": "sha256",
 *     "remote_head": "sha256",
 *     "warnings": ["string", ...],
 *     "followups": ["string", ...]
 *   }
 *
 * The parser first looks for a result.json at a known path. If found and valid,
 * it uses that. Otherwise it falls back to parsing the stdout structured fields.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { VALID_STATUSES, KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT } from "./codex-finalizer-contract.mjs";

// ---------------------------------------------------------------------------
// result.json parser
// ---------------------------------------------------------------------------

/**
 * Try to parse a result.json file from a known path.
 *
 * @param {string} resultJsonPath - Absolute path to result.json file.
 * @returns {Promise<object|null>} Parsed result object or null if not found/invalid.
 */
export async function parseResultJson(resultJsonPath) {
  if (!resultJsonPath) return null;
  try {
    if (!existsSync(resultJsonPath)) return null;
    const text = await readFile(resultJsonPath, "utf8");
    const data = JSON.parse(text);

    // Validate contract fields
    
    const status = data.status && VALID_STATUSES.includes(data.status) ? data.status : null;
    const summary = typeof data.summary === "string" ? data.summary : null;
    const changedFiles = Array.isArray(data.changed_files) ? data.changed_files.filter(f => typeof f === "string") : [];
    const tests = typeof data.tests === "string" ? data.tests : null;
    const commit = typeof data.commit === "string" ? data.commit : null;
    const remoteHead = typeof data.remote_head === "string" ? data.remote_head : null;
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(w => typeof w === "string") : [];
    const followups = Array.isArray(data.followups) ? data.followups.filter(f => typeof f === "string") : [];

    if (!status) return null;

    // Autonomy/subagent reporting fields (optional, P0.4/P1.1)
    const subagentsUsed = data.subagents_used === true ? true : false;
    const subagents = Array.isArray(data.subagents) ? data.subagents : null;
    const gptQuestionsUsed = typeof data.gpt_questions_used === 'number' ? data.gpt_questions_used : null;
    const decisionLog = Array.isArray(data.decision_log) ? data.decision_log : null;
    const verification = data.verification && typeof data.verification === 'object' ? data.verification : null;
    const escalation = data.escalation && typeof data.escalation === 'object' ? data.escalation : null;


    return {
      status,
      summary,
      changed_files: changedFiles,
      tests,
      commit,
      remote_head: remoteHead,
      warnings,
      followups,
      subagents_used: subagentsUsed,
      subagents,
      gpt_questions_used: gptQuestionsUsed,
      decision_log: decisionLog,
      verification,
      escalation,
      structured: true,
      from_json: true,
      json_errors: [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// stdout structured parser (original)
// ---------------------------------------------------------------------------

/**
 * Parse the structured report from Codex output.
 *
 * @param {string} output - The raw output from Codex CLI execution.
 * @returns {object} Parsed result with:
 *   - status: "completed" | "failed" | "timed_out" | null
 *   - summary: string or null
 *   - changed_files: string[] (empty if none)
 *   - tests: string or null
 *   - commit: string or null
 *   - remote_head: string or null
 *   - warnings: string[] (always empty from stdout parser)
 *   - followups: string[] (always empty from stdout parser)
 *   - structured: boolean - true if any structured fields were found
 *   - from_json: false
 *   - raw_summary_excerpt: first 500 chars of raw output for diagnostics
 */
export function parseCodexResult(output) {
  if (!output || typeof output !== "string") {
    return {
      status: null,
      summary: null,
      changed_files: [],
      tests: null,
      commit: null,
      remote_head: null,
      warnings: [],
      followups: [],
      structured: false,
      from_json: false,
      raw_summary_excerpt: null
    };
  }

  const lines = output.split("\n");
  let structured = false;
  let status = null;
  let summary = null;
  let changedFilesRaw = null;
  let tests = null;
  let commit = null;
  let remoteHead = null;
  let subagentsUsed = false;
  let subagents = null;
  let gptQuestionsUsed = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // STATUS=<completed|failed|timed_out>
    const statusMatch = trimmed.match(/^STATUS=(completed|failed|timed_out)$/i);
    if (statusMatch) {
      status = statusMatch[1].toLowerCase();
      structured = true;
      continue;
    }

    // SUMMARY=<one line>
    const summaryMatch = trimmed.match(/^SUMMARY=(.*)$/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // CHANGED_FILES=<comma separated or none>
    const filesMatch = trimmed.match(/^CHANGED_FILES=(.*)$/i);
    if (filesMatch) {
      changedFilesRaw = filesMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // TESTS=<commands and pass/fail or none>
    const testsMatch = trimmed.match(/^TESTS=(.*)$/i);
    if (testsMatch) {
      tests = testsMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // COMMIT=<sha or none>
    const commitMatch = trimmed.match(/^COMMIT=(.*)$/i);
    if (commitMatch) {
      commit = commitMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // REMOTE_HEAD=<sha or none>
    const remoteMatch = trimmed.match(/^REMOTE_HEAD=(.*)$/i);
    if (remoteMatch) {
      remoteHead = remoteMatch[1].trim() || null;
      structured = true;
      continue;
    }

    // SUBAGENTS_USED=<true|false>
    const subagentsUsedMatch = trimmed.match(/^SUBAGENTS_USED=(true|false)$/i);
    if (subagentsUsedMatch) {
      subagentsUsed = subagentsUsedMatch[1].toLowerCase() === 'true';
      structured = true;
      continue;
    }

    // SUBAGENTS=<JSON array> — must be on a single line
    const subagentsMatch = trimmed.match(/^SUBAGENTS=(.*)$/i);
    if (subagentsMatch) {
      try {
        const parsed = JSON.parse(subagentsMatch[1].trim());
        if (Array.isArray(parsed)) subagents = parsed;
      } catch {
        // ignore parse failures
      }
      structured = true;
      continue;
    }

    // GPT_QUESTIONS_USED=<number>
    const gptQuestionsUsedMatch = trimmed.match(/^GPT_QUESTIONS_USED=(\d+)$/i);
    if (gptQuestionsUsedMatch) {
      gptQuestionsUsed = parseInt(gptQuestionsUsedMatch[1], 10);
      if (!Number.isFinite(gptQuestionsUsed)) gptQuestionsUsed = null;
      structured = true;
      continue;
    }
  }

  // Normalize changed_files
  let changedFiles = [];
  if (changedFilesRaw && changedFilesRaw.toLowerCase() !== "none") {
    changedFiles = changedFilesRaw.split(",").map(f => f.trim()).filter(Boolean);
  }

  // Normalize "none" values
  if (status && status === "none") status = null;
  if (summary && summary.toLowerCase() === "none") summary = null;
  if (tests && tests.toLowerCase() === "none") tests = null;
  if (commit && commit.toLowerCase() === "none") commit = null;
  if (remoteHead && remoteHead.toLowerCase() === "none") remoteHead = null;

  return {
    status,
    summary,
    changed_files: changedFiles,
    tests,
    commit,
    remote_head: remoteHead,
    warnings: [],
    followups: [],
    structured,
    from_json: false,
    subagents_used: subagentsUsed,
    subagents,
    gpt_questions_used: gptQuestionsUsed,
    raw_summary_excerpt: output.slice(0, 500)
  };
}

// ---------------------------------------------------------------------------
// Combined parser (prefers result.json, falls back to stdout)
// ---------------------------------------------------------------------------

/**
 * Try to parse result.json first. If not found or invalid, fall back to
 * parsing the stdout structured fields.
 *
 * @param {object} options
 * @param {string} [options.resultJsonPath] - Path to result.json file.
 * @param {string} [options.stdout] - Raw stdout from Codex CLI execution.
 * @returns {Promise<object>} Parsed result object.
 */
export async function parseCodexResultWithFallback({ resultJsonPath, stdout } = {}) {
  // Try result.json first
  if (resultJsonPath) {
    const jsonResult = await parseResultJson(resultJsonPath);
    if (jsonResult) {
      return jsonResult;
    }
  }

  // Fall back to stdout parser
  const stdoutResult = parseCodexResult(stdout);

  // Add a note that we attempted result.json but fell back
  if (resultJsonPath) {
    stdoutResult._result_json_path = resultJsonPath;
    stdoutResult._result_json_error = "not found or invalid";
  }

  return stdoutResult;
}

// ---------------------------------------------------------------------------
// Task result builder (unchanged interface, extended with warnings/followups)
// ---------------------------------------------------------------------------

/**
 * Build a task.result object from parsed Codex output for successful execution.
 *
 * @param {object} parsed - Result from parseCodexResult() or parseResultJson()
 * @param {object} options
 * @param {boolean} options.timedOut - Whether the process timed out
 * @param {number} options.timeoutSeconds - Timeout duration in seconds
 * @param {number} options.returnCode - Process exit code
 * @returns {object} Task result object
 */
export function buildTaskResult(parsed, { timedOut = false, timeoutSeconds = 0, returnCode = 0 } = {}) {
  const now = new Date().toISOString();

  if (timedOut) {
    return {
      kind: KIND_TIMEOUT,
      summary: parsed.summary || "Codex execution timed out",
      timed_out: true,
      timeout_seconds: timeoutSeconds,
      changed_files: parsed.changed_files || [],
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now
    };
  }

  // If STATUS=failed (structured failure, not timeout)
  if (parsed.status === "failed") {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution reported failure",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false
    };
  }

  // If STATUS=completed (success)
  if (parsed.status === "completed") {
    return {
      kind: KIND_EXECUTED,
      summary: parsed.summary || "Codex execution completed (no structured summary)",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now
    };
  }

  // If STATUS=timed_out but process didn't actually time out, treat as failed
  if (parsed.status === "timed_out") {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution reported timeout (no process timeout)",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false
    };
  }

  // If no structured STATUS field was found, use exit code to decide
  if (returnCode !== 0) {
    return {
      kind: KIND_FAILED,
      summary: parsed.summary || "Codex execution failed (non-zero exit)",
      structured: parsed.structured,
      from_json: parsed.from_json,
      changed_files: parsed.changed_files || [],
      tests: parsed.tests,
      commit: parsed.commit,
      remote_head: parsed.remote_head,
      warnings: parsed.warnings || [],
      followups: parsed.followups || [],
      completed_at: now,
      timed_out: false
    };
  }

  return {
    kind: KIND_EXECUTED,
    summary: parsed.summary || "Codex execution completed (no structured summary)",
    structured: parsed.structured,
    from_json: parsed.from_json,
    changed_files: parsed.changed_files || [],
    tests: parsed.tests,
    commit: parsed.commit,
    remote_head: parsed.remote_head,
    warnings: parsed.warnings || [],
    followups: parsed.followups || [],
    completed_at: now
  };
}


// ---------------------------------------------------------------------------
// Autonomy policy validation (P1.1)
// ---------------------------------------------------------------------------

/**
}

// ---------------------------------------------------------------------------
// Role name normalization (P0 hotfix: role alias support)
// ---------------------------------------------------------------------------

/**
 * Known role name aliases mapping non-canonical names to their canonical form.
 * This allows flexibility in subagent reporting without weakening strict validation.
 * Add aliases here when equivalent role names are encountered in practice.
 */
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
