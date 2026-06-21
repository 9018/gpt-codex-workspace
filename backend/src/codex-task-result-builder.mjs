import { KIND_EXECUTED, KIND_FAILED, KIND_TIMEOUT } from "./codex-finalizer-contract.mjs";

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
