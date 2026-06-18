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
    const validStatuses = ["completed", "failed", "timed_out"];
    const status = data.status && validStatuses.includes(data.status) ? data.status : null;
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
      kind: "codex_timeout",
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
      kind: "codex_failed",
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
      kind: "codex_executed",
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
      kind: "codex_failed",
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
      kind: "codex_failed",
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
    kind: "codex_executed",
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
 * Validate that a Codex result.json satisfies the goal's autonomy/subagent policy.
 *
 * @param {object} result - Parsed result object from parseResultJson or parseCodexResult.
 * @param {object} [goal] - Goal object with optional autonomy_policy and subagent_policy.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateAutonomyResult(result, goal) {
  const autonomy = goal?.autonomy_policy || {};
  const subagent = goal?.subagent_policy || {};

  if (subagent.mode === 'required' && result.subagents_used !== true) {
    return { valid: false, reason: 'subagents_required_but_not_used' };
  }
  if (subagent.mode === 'required' && !Array.isArray(result.subagents)) {
    return { valid: false, reason: 'missing_subagent_report' };
  }
  const budget = autonomy.gpt_question_budget ?? 0;
  const used = result.gpt_questions_used ?? 0;
  if (used > budget) {
    return { valid: false, reason: 'gpt_question_budget_exceeded' };
  }
  return { valid: true };
}
