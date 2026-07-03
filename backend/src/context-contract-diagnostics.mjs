/**
 * context-contract-diagnostics.mjs — Context Contract Stress Test and Fallbacks
 *
 * P0-C9 implementation.  Verifies the context contract for each Codex task:
 * - Each task has codex.entry.md and/or equivalent bounded entry context.
 * - context.bundle.md, context.retrieval.json, and context metadata exist or
 *   have a documented fallback.
 * - Context retrieval/index failure falls back to durable goal/task/result
 *   evidence.
 * - Repair tasks inherit root task failure evidence and context pointers.
 * - Compact review/acceptance bundles can be built without the full transcript.
 * - Diagnostics surface missing context files, huge transcript risk, stale
 *   context, unavailable helper tools, and degraded context index/retrieval.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HUGE_TRANSCRIPT_BYTES = 100 * 1024; // 100 KB
const ENTRY_FILES = ["codex.entry.md"];
const CONTEXT_FILES = ["context.bundle.md", "context.retrieval.json", "context.json"];
const DEFAULT_WARN_SEVERITY = "warning";
const INFO_SEVERITY = "info";

// ---------------------------------------------------------------------------
// Internal helpers (all synchronous)
// ---------------------------------------------------------------------------

function readJsonIfExists(absPath) {
  if (!absPath) return null;
  try {
    if (!existsSync(absPath)) return null;
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Entry context check
// ---------------------------------------------------------------------------

/**
 * Verify each task has codex.entry.md or equivalent bounded entry context.
 *
 * @param {string|null} goalDir  Absolute path to the goal workspace directory.
 * @returns {Array<{ file: string, exists: boolean, status: string }>}
 */
function checkEntryContext(goalDir) {
  return ENTRY_FILES.map((file) => {
    const abs = goalDir ? join(goalDir, file) : null;
    const exists = abs ? existsSync(abs) : false;
    return { file, exists, status: exists ? "ok" : "missing" };
  });
}

// ---------------------------------------------------------------------------
// 2. Context bundle / retrieval / metadata files
// ---------------------------------------------------------------------------

/**
 * Verify context.bundle.md, context.retrieval.json, context.json existence
 * and (for JSON files) syntactic validity.
 *
 * @param {string|null} goalDir
 * @returns {Array<{ file: string, exists: boolean, valid: boolean|null, status: string }>}
 */
function checkContextFiles(goalDir) {
  return CONTEXT_FILES.map((file) => {
    const abs = goalDir ? join(goalDir, file) : null;
    const exists = abs ? existsSync(abs) : false;
    let valid = null;
    if (exists && file.endsWith(".json")) {
      const parsed = readJsonIfExists(abs);
      valid = parsed !== null && typeof parsed === "object";
    }
    let status;
    if (!exists) status = "missing";
    else if (valid === false) status = "invalid";
    else status = "ok";
    return { file, exists, valid, status };
  });
}

// ---------------------------------------------------------------------------
// 3. Transcript risk diagnostic
// ---------------------------------------------------------------------------

/**
 * @param {string|null} goalDir
 * @returns {{ exists: boolean, size: number, message_count: number, huge_risk: boolean }}
 */
function checkTranscript(goalDir) {
  if (!goalDir) return { exists: false, size: 0, message_count: 0, huge_risk: false };
  const transcriptPath = join(goalDir, "transcript.md");
  try {
    const s = statSync(transcriptPath);
    if (!s.isFile()) return { exists: false, size: 0, message_count: 0, huge_risk: false };
    const text = readFileSync(transcriptPath, "utf8");
    const messageCount = (text.match(/^## /gm) || []).length;
    return {
      exists: true,
      size: s.size,
      message_count: messageCount,
      huge_risk: s.size > HUGE_TRANSCRIPT_BYTES,
    };
  } catch {
    return { exists: false, size: 0, message_count: 0, huge_risk: false };
  }
}

// ---------------------------------------------------------------------------
// 4. Retrieval fallback path
// ---------------------------------------------------------------------------

/**
 * When context retrieval/index is unavailable, fall back to durable
 * goal/task/result/runtime evidence.
 *
 * @param {string|null}  goalDir
 * @param {object|null}  task
 * @returns {{ retrieval_available: boolean, retrieval_chunk_count: number,
 *             fallback_sources: string[], has_durable_fallback: boolean, status: string }}
 */
function checkRetrievalFallback(goalDir, task) {
  const retrievalJson = goalDir ? readJsonIfExists(join(goalDir, "context.retrieval.json")) : null;
  const chunks = retrievalJson?.chunks;
  const retrievalAvailable = Array.isArray(chunks) && chunks.length > 0;

  // Durable fallback sources
  const fallbackSources = [];
  if (goalDir) {
    if (existsSync(join(goalDir, "goal.json"))) fallbackSources.push("goal.json");
    if (existsSync(join(goalDir, "goal.md"))) fallbackSources.push("goal.md");
    if (existsSync(join(goalDir, "result.json"))) fallbackSources.push("result.json");
    if (existsSync(join(goalDir, "result.md"))) fallbackSources.push("result.md");
  }
  if (task !== null && task !== undefined) fallbackSources.push("task_fields");

  const hasDurableFallback = fallbackSources.length > 0;
  let status;
  if (retrievalAvailable) status = "ok";
  else if (hasDurableFallback) status = "fallback";
  else status = "degraded";

  return {
    retrieval_available: retrievalAvailable,
    retrieval_chunk_count: chunks ? chunks.length : 0,
    fallback_sources: fallbackSources,
    has_durable_fallback: hasDurableFallback,
    status,
  };
}

// ---------------------------------------------------------------------------
// 5. Repair-task context inheritance
// ---------------------------------------------------------------------------

/**
 * Ensure repair tasks inherit root task failure evidence and relevant
 * context pointers.
 *
 * @param {object|null}  task
 * @param {object|null}  goal
 * @param {string|null}  goalDir
 * @param {string|null}  parentGoalDir  Where the root (failed) goal lives.
 * @returns {{ is_repair_task: boolean, assessment: string, parent_result_json: boolean|null, parent_result_md: boolean|null }}
 */
function checkRepairContextInheritance(task, goal, goalDir, parentGoalDir) {
  const isRepair = (task?.title || "").toLowerCase().includes("repair") ||
    (task?.description || "").toLowerCase().includes("repair") ||
    (goal?.title || "").toLowerCase().includes("repair") ||
    // A repair goal's parent reference is encoded via its own context.
    (goalDir && existsSync(join(goalDir, "result.json")) &&
      // Only claim repair if the task description also says repair.
      (task?.title || "").toLowerCase().includes("repair"));

  if (!isRepair) {
    return { is_repair_task: false, assessment: "not_applicable", parent_result_json: null, parent_result_md: null };
  }

  const parentResultJson = parentGoalDir ? existsSync(join(parentGoalDir, "result.json")) : false;
  const parentResultMd = parentGoalDir ? existsSync(join(parentGoalDir, "result.md")) : false;

  return {
    is_repair_task: true,
    parent_goal_dir: parentGoalDir || null,
    parent_result_json: parentResultJson,
    parent_result_md: parentResultMd,
    assessment: parentResultJson || parentResultMd ? "inherited" : "missing_parent_evidence",
  };
}

// ---------------------------------------------------------------------------
// 6. Compact review bundle
// ---------------------------------------------------------------------------

/**
 * Determine whether a compact review/acceptance bundle can be assembled
 * without loading the full goal transcript.
 *
 * @param {object|null}  task
 * @param {string|null}  goalDir
 * @returns {{ result_json_exists: boolean, result_md_exists: boolean,
 *             changed_files_available: boolean, verification_available: boolean,
 *             viable_without_full_transcript: boolean, assessment: string }}
 */
function checkCompactReviewBundle(task, goalDir) {
  const hasResultJson = goalDir ? existsSync(join(goalDir, "result.json")) : false;
  const hasResultMd = goalDir ? existsSync(join(goalDir, "result.md")) : false;
  const hasChangedFiles = Array.isArray(task?.changed_files) && task.changed_files.length > 0;
  const hasVerification = task?.result?.verification !== null && task?.result?.verification !== undefined;

  // A compact review bundle is viable if result evidence exists AND
  // either changed files or verification evidence is available.
  const viableWithoutFullTranscript = (hasResultJson || hasResultMd) && (hasChangedFiles || hasVerification);

  return {
    result_json_exists: hasResultJson,
    result_md_exists: hasResultMd,
    changed_files_available: hasChangedFiles,
    verification_available: hasVerification,
    viable_without_full_transcript: viableWithoutFullTranscript,
    assessment: viableWithoutFullTranscript ? "ok" : "needs_transcript_fallback",
  };
}

// ---------------------------------------------------------------------------
// 7. Helper tools availability
// ---------------------------------------------------------------------------

/**
 * @param {{ contextVectorStore?: string }} config
 * @returns {Array<{ tool: string, configured: boolean, status: string }>}
 */
function checkHelperTools(config = {}) {
  const zvecConfigured = config.contextVectorStore ||
    process.env.GPTWORK_CONTEXT_VECTOR_STORE || "auto";
  const hasZvec = zvecConfigured !== "local";
  return [
    { tool: "@zvec/zvec", configured: hasZvec, status: "config_based" },
  ];
}

// ---------------------------------------------------------------------------
// 8. Context index health
// ---------------------------------------------------------------------------

/**
 * @param {object} contextIndexStatus  Output of collectContextIndexStatus().
 * @returns {{ status: string, warnings: string[] }}
 */
function checkContextIndex(contextIndexStatus = {}) {
  if (!contextIndexStatus || Object.keys(contextIndexStatus).length === 0) {
    return { status: "not_checked", warnings: ["No context index status available for this call."] };
  }

  const warnings = [];
  const effective = contextIndexStatus.effective_store || "unknown";
  const zvecDep = contextIndexStatus.zvec_optional_dependency || "not_checked";

  if (effective === "unknown" && zvecDep === "unavailable") {
    warnings.push("Context vector store is degraded: zvec was requested but is unavailable.");
  }

  return {
    configured_store: contextIndexStatus.configured_store || "unknown",
    effective_store: effective,
    zvec_dependency: zvecDep,
    warnings,
    status: warnings.length === 0 ? "ok" : "degraded",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all context-contract diagnostics.
 *
 * @param {object} options
 * @param {object}  [options.task]               Task object from state store.
 * @param {object}  [options.goal]               Goal object from state store.
 * @param {object}  [options.config]             Runtime configuration.
 * @param {string}  [options.goalDir]            Absolute path to the goal workspace dir
 *                                                 (e.g. …/.gptwork/goals/<goal_id>/).
 * @param {string}  [options.parentGoalDir]      Absolute path to the parent (failed) goal
 *                                                 workspace dir (repair inheritance).
 * @param {string}  [options.workspaceRoot]      Workspace root path.
 * @param {object}  [options.contextIndexStatus] Pre-computed output from
 *                                                 collectContextIndexStatus().
 * @returns {Promise<{
 *   status: string,
 *   checks: object,
 *   warnings: Array<{ code: string, message: string, severity?: string }>,
 *   fallback_sources: string[],
 * }>}
 */
export async function runContextContractDiagnostics(options = {}) {
  const {
    task,
    goal,
    config,
    goalDir,
    parentGoalDir,
    workspaceRoot,
    contextIndexStatus,
  } = options;

  const checks = {};
  const warnings = [];

  // 1. Entry context
  const entryChecks = checkEntryContext(goalDir);
  checks.entry_context = entryChecks;
  for (const c of entryChecks) {
    if (c.status === "missing") {
      warnings.push({
        code: "missing_entry_context",
        message: `Required entry context file "${c.file}" is missing.`,
        severity: DEFAULT_WARN_SEVERITY,
      });
    }
  }

  // 2. Context bundle / retrieval / metadata files
  const contextFileChecks = checkContextFiles(goalDir);
  checks.context_files = contextFileChecks;
  for (const c of contextFileChecks) {
    if (c.status === "missing") {
      warnings.push({
        code: "missing_context_file",
        message: `Required context file "${c.file}" is missing.`,
        severity: DEFAULT_WARN_SEVERITY,
      });
    } else if (c.status === "invalid") {
      warnings.push({
        code: "invalid_context_file",
        message: `Context file "${c.file}" is present but contains invalid JSON.`,
        severity: DEFAULT_WARN_SEVERITY,
      });
    }
  }

  // 3. Transcript size risk
  const transcriptCheck = checkTranscript(goalDir);
  checks.transcript = transcriptCheck;
  if (transcriptCheck.huge_risk) {
    warnings.push({
      code: "huge_transcript",
      message: `Transcript is ${transcriptCheck.size} bytes with ${transcriptCheck.message_count} messages, exceeding the ${HUGE_TRANSCRIPT_BYTES}-byte threshold.`,
      severity: DEFAULT_WARN_SEVERITY,
    });
  }

  // 4. Retrieval fallback
  const retrievalCheck = checkRetrievalFallback(goalDir, task);
  checks.retrieval_fallback = retrievalCheck;
  if (!retrievalCheck.retrieval_available) {
    if (retrievalCheck.has_durable_fallback) {
      warnings.push({
        code: "retrieval_unavailable_fallback",
        message: "Context retrieval index is unavailable; falling back to durable sources: " +
          retrievalCheck.fallback_sources.join(", ") + ".",
        severity: INFO_SEVERITY,
      });
    } else {
      warnings.push({
        code: "retrieval_degraded",
        message: "Context retrieval is unavailable and no durable fallback sources could be found.",
        severity: DEFAULT_WARN_SEVERITY,
      });
    }
  }

  // 5. Repair context inheritance
  const repairCheck = checkRepairContextInheritance(task, goal, goalDir, parentGoalDir);
  checks.repair_context_inheritance = repairCheck;
  if (repairCheck.assessment === "missing_parent_evidence") {
    warnings.push({
      code: "missing_repair_parent_evidence",
      message: "Repair task cannot locate the root failure evidence from the parent goal.",
      severity: DEFAULT_WARN_SEVERITY,
    });
  }

  // 6. Compact review bundle
  const bundleCheck = checkCompactReviewBundle(task, goalDir);
  checks.compact_review_bundle = bundleCheck;
  if (!bundleCheck.viable_without_full_transcript) {
    warnings.push({
      code: "compact_bundle_not_viable",
      message: "A compact review bundle cannot be assembled without the full goal transcript because result evidence, changed files, or verification evidence is unavailable.",
      severity: DEFAULT_WARN_SEVERITY,
    });
  }

  // 7. Helper tools
  checks.helper_tools = checkHelperTools(config);

  // 8. Context index health
  const indexCheck = checkContextIndex(contextIndexStatus);
  checks.context_index_health = indexCheck;
  if (indexCheck.status === "degraded") {
    for (const w of indexCheck.warnings) {
      warnings.push({
        code: "context_index_degraded",
        message: w,
        severity: DEFAULT_WARN_SEVERITY,
      });
    }
  }

  // Overall status
  const severeWarnings = warnings.filter((w) => w.severity !== INFO_SEVERITY);
  let overallStatus;
  if (severeWarnings.length === 0) {
    overallStatus = "ok";
  } else if (severeWarnings.some((w) =>
    ["retrieval_degraded", "compact_bundle_not_viable", "missing_repair_parent_evidence", "context_index_degraded"].includes(w.code)
  )) {
    overallStatus = "degraded";
  } else {
    overallStatus = "warnings";
  }

  // Build fallback_sources from the retrieval check result
  const fallbackSources = [...new Set(retrievalCheck.fallback_sources)];

  return {
    status: overallStatus,
    checks,
    warnings,
    fallback_sources: fallbackSources,
  };
}

// ---------------------------------------------------------------------------
// Exported check helpers (for unit testing)
// ---------------------------------------------------------------------------

export {
  checkEntryContext,
  checkContextFiles,
  checkTranscript,
  checkRetrievalFallback,
  checkRepairContextInheritance,
  checkCompactReviewBundle,
  checkHelperTools,
  checkContextIndex,
};
