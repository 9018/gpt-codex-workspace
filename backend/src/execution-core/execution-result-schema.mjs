/**
 * execution-result-schema.mjs — ExecutionResult (result.json) strong contract.
 *
 * Every provider attempt must produce a normalized ExecutionResult that
 * passes validation.  Missing or invalid fields trigger evidence repair,
 * not a blanket "provider failed" declaration.
 *
 * @module execution-result-schema
 */

/**
 * Validate a raw execution result against the contract.
 *
 * @param {object} result
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateExecutionResult(result) {
  const errors = [];

  if (!result || typeof result !== "object") {
    return { valid: false, errors: ["result must be a non-null object"] };
  }

  if (!result.run_id) errors.push("run_id is required");
  if (!result.attempt_id) errors.push("attempt_id is required");

  const validOutcomes = ["succeeded", "failed", "partial"];
  if (!validOutcomes.includes(result.outcome)) {
    errors.push(`outcome must be one of: ${validOutcomes.join(", ")}`);
  }

  if (!Array.isArray(result.changed_files)) {
    errors.push("changed_files must be an array");
  }

  if (!Array.isArray(result.commands)) {
    errors.push("commands must be an array");
  } else {
    for (let i = 0; i < result.commands.length; i++) {
      const cmd = result.commands[i];
      if (!cmd || typeof cmd !== "object") {
        errors.push(`commands[${i}] must be an object`);
      } else {
        if (typeof cmd.command !== "string" || !cmd.command.trim()) {
          errors.push(`commands[${i}].command must be a non-empty string`);
        }
        if (cmd.exit_code !== undefined && cmd.exit_code !== null && !Number.isInteger(cmd.exit_code)) {
          errors.push(`commands[${i}].exit_code must be an integer or null`);
        }
      }
    }
  }

  if (result.commit_sha !== undefined && result.commit_sha !== null && result.commit_sha !== "") {
    if (typeof result.commit_sha !== "string" || result.commit_sha.length < 6) {
      errors.push("commit_sha must be a string of at least 6 characters when provided");
    }
  }

  if (result.worktree_clean !== undefined && typeof result.worktree_clean !== "boolean") {
    errors.push("worktree_clean must be a boolean when provided");
  }

  if (!Array.isArray(result.blockers)) {
    errors.push("blockers must be an array");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a normalized ExecutionResult.
 *
 * @param {object} input
 * @returns {object} Normalized result
 */
export function createExecutionResult(input = {}) {
  const result = {
    schema_version: 2,
    run_id: input.run_id || null,
    attempt_id: input.attempt_id || null,
    outcome: input.outcome || "partial",
    summary: input.summary || "",
    changed_files: Array.isArray(input.changed_files) ? [...input.changed_files] : [],
    commands: Array.isArray(input.commands)
      ? input.commands.map(normalizeCommand)
      : [],
    commit_sha: input.commit_sha || null,
    worktree_clean: input.worktree_clean !== false,
    blockers: Array.isArray(input.blockers) ? [...input.blockers] : [],
    followup_findings: Array.isArray(input.followup_findings) ? [...input.followup_findings] : [],
    created_at: input.created_at || new Date().toISOString(),
  };

  const { valid, errors } = validateExecutionResult(result);
  if (!valid) {
    throw new Error(`Invalid ExecutionResult: ${errors.join("; ")}`);
  }

  return result;
}

function normalizeCommand(cmd) {
  return {
    command: String(cmd.command || ""),
    cwd: cmd.cwd || null,
    exit_code: cmd.exit_code !== undefined && cmd.exit_code !== null ? Number(cmd.exit_code) : null,
    duration_ms: cmd.duration_ms != null ? Number(cmd.duration_ms) : null,
    stdout_ref: cmd.stdout_ref || null,
    stderr_ref: cmd.stderr_ref || null,
  };
}

/**
 * Check if a result is missing required evidence that can be repaired.
 *
 * @param {object} result
 * @returns {string[]} List of missing evidence items
 */
export function findMissingEvidence(result) {
  const missing = [];

  if (!result.run_id) missing.push("run_id");
  if (!result.attempt_id) missing.push("attempt_id");
  if (!result.outcome || result.outcome === "partial") missing.push("outcome");
  if (!result.changed_files || result.changed_files.length === 0) missing.push("changed_files");
  if (!result.commands || result.commands.length === 0) missing.push("commands");
  if (!result.commit_sha) missing.push("commit_sha");

  return missing;
}
