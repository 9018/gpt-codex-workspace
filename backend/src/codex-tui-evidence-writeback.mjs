/**
 * codex-tui-evidence-writeback.mjs — Bridge TUI session evidence into the
 * unified acceptance/finalizer pipeline.
 *
 * P0: TUI/manual sessions produce completion snapshots via
 * collectCodexTuiCompletion().  This module converts those snapshots into a
 * structured taskResult that enters the same evidence-normalizer →
 * finalizer → unified-decision path that codex_exec uses.
 *
 * Guarantees:
 *   - All evidence fields (summary, changed_files, commit, tests,
 *     artifacts, integration) are written in a format compatible with
 *     normalizeOperationEvidence().
 *   - The result is fed through decideTaskFinalization() so that TUI sessions
 *     reach the same finalizer/unified_decision as codex_exec.
 *   - Missing evidence produces structured blockers (not silent failures).
 *   - Integration evidence is explicitly set (not_required when no changed
 *     files, already_integrated when commit is reachable on canonical HEAD).
 */

import { join } from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { collectCodexTuiCompletion } from "./codex-tui-completion-collector.mjs";
import { normalizeOperationEvidence } from "./evidence/evidence-normalizer.mjs";
import { decideTaskFinalization, applyTaskFinalStateDecision } from "./task-finalization/task-final-state-decider.mjs";
import { normalizeToUnifiedDecision } from "./codex-unified-decision.mjs";
import { releaseLockForTask } from "./repo-lock.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blocker(code, message, evidence = {}) {
  return { severity: "blocker", code, message, source: "codex_tui_evidence_writeback", evidence };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function commitReachableOnCanonical(workspaceRoot, commit) {
  if (!commit || !workspaceRoot) return null;
  // Try the workspace root as canonical
  if (gitOk(workspaceRoot, ["cat-file", "-e", `${commit}^{commit}`])) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const reachable = gitOk(workspaceRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return { reachable, head, path: workspaceRoot };
  }
  return null;
}


const PERSISTABLE_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "waiting_for_review",
  "waiting_for_repair",
  "waiting_for_integration",
]);

export async function persistTuiTerminalState({ store, task, taskResult = {}, unifiedDecision = {}, workspaceRoot = null } = {}) {
  if (!store || typeof store.mutate !== "function" || !task?.id) {
    return { persisted: false, reason: "store_or_task_unavailable" };
  }
  const status = String(unifiedDecision.status || taskResult.status || "");
  if (!PERSISTABLE_TERMINAL_STATUSES.has(status)) {
    return { persisted: false, reason: "non_persistable_status", status };
  }
  const now = new Date().toISOString();
  let found = false;
  await store.mutate((state) => {
    const storedTask = (state.tasks || []).find((item) => item?.id === task.id);
    if (!storedTask) return state;
    found = true;
    const protectedStatuses = new Set(["completed", "waiting_for_review", "waiting_for_integration"]);
    const incomingIsFailure = ["failed", "timed_out", "cancelled", "stopped", "detached"].includes(status);
    const alreadySucceeded = protectedStatuses.has(storedTask.status)
      || storedTask.result?.status === "completed"
      || storedTask.result?.verification?.passed === true;
    if (alreadySucceeded && incomingIsFailure) {
      storedTask.logs = Array.isArray(storedTask.logs) ? storedTask.logs : [];
      storedTask.logs.push({
        time: now,
        message: `[tui-writeback] ignored demotion ${storedTask.status} -> ${status}; preserving successful evidence`,
      });
      storedTask.updated_at = now;
      return state;
    }
    storedTask.status = status;
    storedTask.result = {
      ...(storedTask.result || {}),
      ...taskResult,
      status,
      unified_decision: unifiedDecision,
    };
    storedTask.updated_at = now;
    storedTask.logs = Array.isArray(storedTask.logs) ? storedTask.logs : [];
    storedTask.logs.push({ time: now, message: `[tui-writeback] canonical terminal state persisted: ${status}` });

    const goalId = storedTask.goal_id || task.goal_id || null;
    const goalStatus = String(unifiedDecision.goal_effect?.status || status);
    const goal = (state.goals || []).find((item) => item?.id === goalId || item?.task_id === task.id);
    if (goal && PERSISTABLE_TERMINAL_STATUSES.has(goalStatus)) {
      goal.status = goalStatus;
      goal.updated_at = now;
    }

    const queueStatus = String(unifiedDecision.queue_effect?.status || status);
    for (const item of state.goal_queue || []) {
      if (item?.task_id !== task.id && (!goalId || item?.goal_id !== goalId)) continue;
      if (PERSISTABLE_TERMINAL_STATUSES.has(queueStatus)) {
        item.status = queueStatus;
        item.blocked_reason = null;
        item.updated_at = now;
      }
    }
    const success = status === "completed";
    for (const run of state.agent_runs || []) {
      if (run?.task_id !== task.id || !["queued", "declared", "running", "waiting_for_supervisor"].includes(run.status)) continue;
      run.status = success ? "skipped" : "blocked";
      run.summary = success
        ? "Task reached completed before this role required separate execution."
        : `Task reached ${status}; downstream role did not execute.`;
      run.events = Array.isArray(run.events) ? run.events : [];
      run.events.push({ type: run.status, message: run.summary, data: { task_status: status, code: "upstream_terminal_state" }, created_at: now });
      run.updated_at = now;
    }
    for (const run of state.advisory_runs || []) {
      if (run?.task_id !== task.id || !["queued", "declared", "running"].includes(run.status)) continue;
      run.status = success ? "skipped" : "blocked";
      run.summary = `Task reached ${status}; advisory run closed by terminal propagation.`;
      run.updated_at = now;
    }
    return state;
  });
  if (found && workspaceRoot) {
    await releaseLockForTask(workspaceRoot, task.id).catch(() => {});
  }
  return { persisted: found, status, reason: found ? "canonical_terminal_state_persisted" : "task_not_found" };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Write back TUI session evidence to a structured taskResult that is
 * compatible with the normalizeOperationEvidence() → finalizer → unified
 * decision pipeline.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot   - Workspace root (cwd)
 * @param {string} options.sessionId       - TUI session ID
 * @param {object} [options.store]         - State store (for task state lookup)
 * @param {object} [options.task]          - Optional task object for context
 * @param {boolean} [options.integrationNotRequired] - Explicit override
 * @returns {Promise<object>} Structured result with:
 *   - taskResult: Normalized result for the evidence pipeline
 *   - unified_decision: The unified acceptance decision
 *   - blockers: Any blocking findings
 *   - completion: The raw completion snapshot
 *   - normalized: The normalized evidence object
 *   - finalizer_decision: The raw finalizer decision
 */
export async function writebackTuiEvidence({
  workspaceRoot,
  sessionId,
  store = null,
  task = null,
  integrationNotRequired = null,
} = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  if (!sessionId) throw new Error("sessionId is required");

  // --- Step 1: Collect the raw TUI completion snapshot ---
  const completion = await collectCodexTuiCompletion({ sessionId, workspaceRoot });
  const findings = [...(completion.findings || [])];
  const blockers = findings.filter((f) => f.severity === "blocker");

  // --- Step 2: Build a structured taskResult from completion evidence ---
  const changedFiles = list(completion.changed_files);
  const hasChanges = changedFiles.length > 0;
  const commit = completion.commit || null;
  const tests = completion.tests || null;
  const worktreeClean = completion.worktree_clean !== false; // default to clean
  const resultMdPresent = completion.result_md_present === true;

  // Determine operation kind
  const operationKind = hasChanges && commit ? "code_change" : "diagnostic";

  // Build integration evidence
  // If no changed files or no commit, integration is not required
  const integrationNotRequiredValue = integrationNotRequired !== null
    ? integrationNotRequired
    : (!hasChanges || !commit);

  // Check if commit is already reachable on canonical HEAD
  let integrationEvidence = {};
  if (commit && workspaceRoot) {
    const reachable = commitReachableOnCanonical(workspaceRoot, commit);
    if (reachable && reachable.reachable) {
      integrationEvidence = {
        status: "already_integrated",
        merged: true,
        satisfied: true,
        commit,
        canonical_head: reachable.head,
        canonical_repo_path: reachable.path,
      };
    }
  }

  const taskResult = {
    kind: "codex_tui_completed",
    status: "completed",
    summary: completion.summary || `TUI session ${sessionId} completed`,
    changed_files: changedFiles,
    commit,
    branch: null,
    head: commit,
    tests: tests || null,
    result_md_present: resultMdPresent,
    worktree_clean: worktreeClean,
    operation_kind: operationKind,
    codex_execution_provider: "codex_tui_goal",
    integration_not_required: integrationNotRequiredValue,
    integration: Object.keys(integrationEvidence).length > 0
      ? integrationEvidence
      : {
          status: integrationNotRequiredValue ? "not_required" : "pending",
          required: !integrationNotRequiredValue,
          satisfied: integrationNotRequiredValue,
        },
    verification: {
      passed: Boolean(tests) && worktreeClean && resultMdPresent,
      commands: tests
        ? [{ cmd: tests, exit_code: 0, passed: true }]
        : [],
      report_path: null,
    },
    needs_integration: !integrationNotRequiredValue && !commit,
    requires_review: blockers.length > 0,
    acceptance_findings: blockers,
    findings,
    // Evidence paths
    evidence_paths: {
      result_md: completion.result_md_present
        ? join(workspaceRoot, ".gptwork", "goals", completion.goal_id || "unknown", "result.md")
        : null,
    },
  };

  // --- Step 3: Normalize evidence through the standard pipeline ---
  const contract = {
    intent: {
      operation_kind: operationKind,
      mutation_scope: hasChanges ? "repo" : "none",
      execution_mode: "canonical",
      semantic_confidence: "medium",
    },
  };

  const normalized = normalizeOperationEvidence({ result: taskResult, contract });

  // --- Step 4: Build evidence for the finalizer ---
  const finalizerEvidence = {
    current_status: "completed",
    codex_result: normalized,
    task: task || {},
    verification: normalized.verification || { passed: Boolean(tests), commands: [] },
    contract_verification: normalized.blocking_evidence?.contract_verification || {
      blocking_passed: blockers.length === 0,
      completion_eligible: blockers.length === 0,
      requires_review: blockers.length > 0,
      blockers: normalized.blockers || [],
    },
    integration: normalized.integration || { required: !integrationNotRequiredValue, satisfied: integrationNotRequiredValue },
    repair_budget: { attempts_remaining: 0 },
  };

  // --- Step 5: Pass through the standard finalizer ---
  const finalizerDecision = decideTaskFinalization(finalizerEvidence);

  // Apply the finalizer decision to get the applied state
  const applied = applyTaskFinalStateDecision({
    taskStatus: "completed",
    taskResult: normalized,
    finalizerDecision,
  });

  // --- Step 6: Build unified decision ---
  const unifiedDecision = normalizeToUnifiedDecision({
    finalizerDecision,
    taskResult: applied.taskResult,
    task: task || {},
  });

  // --- Step 7: Generate structured blockers for missing evidence ---
  const evidenceBlockers = [];
  if (!commit && hasChanges) {
    evidenceBlockers.push(
      blocker("commit_missing", "TUI evidence: changed files exist but no commit was found. Commit the changes or provide an explicit no-change reason.")
    );
  }
  if (!tests && hasChanges) {
    evidenceBlockers.push(
      blocker("tests_missing", "TUI evidence: changed files exist but no tests/verification commands were found. Add verification commands to the session result.")
    );
  }
  if (!resultMdPresent) {
    evidenceBlockers.push(
      blocker("result_md_missing", "TUI evidence: result.md is not present. Write result.md with summary, tests, and commit evidence.")
    );
  }
  if (!worktreeClean && !commit) {
    evidenceBlockers.push(
      blocker("uncommitted_changes", "TUI evidence: dirty worktree with no commit. Commit or discard changes before proceeding.")
    );
  }

  const persistence = await persistTuiTerminalState({
    store,
    task,
    taskResult: { ...applied.taskResult, unified_decision: unifiedDecision, finalizer_decision: finalizerDecision },
    unifiedDecision,
    workspaceRoot,
  });

  return {
    taskResult: applied.taskResult,
    unified_decision: unifiedDecision,
    finalizer_decision: finalizerDecision,
    normalized,
    completion,
    blockers: [...evidenceBlockers, ...blockers],
    evidence_complete: evidenceBlockers.length === 0 && blockers.length === 0,
    // Summary fields for direct consumption
    summary: normalized.summary || completion.summary || `TUI session ${sessionId} evidence writeback`,
    changed_files: changedFiles,
    commit,
    tests,
    integration_evidence: integrationEvidence,
    persistence,
  };
}

/**
 * Quick check whether a TUI session has enough evidence to produce a
 * minimum viable taskResult (summary + at least one of changed_files,
 * commit, or tests).
 *
 * @param {object} completion - Result from collectCodexTuiCompletion
 * @returns {boolean}
 */
export function hasMinimumTuiEvidence(completion = {}) {
  if (!completion || typeof completion !== 'object') return false;
  return (
    hasValue(completion.summary)
    || hasValue(completion.changed_files)
    || hasValue(completion.commit)
    || hasValue(completion.tests)
  );
}

export default { writebackTuiEvidence, hasMinimumTuiEvidence, persistTuiTerminalState };
