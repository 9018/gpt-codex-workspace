/**
 * agent-run-writeback.mjs — Agent run writeback adapter.
 *
 * Connects the agent_run / artifact contract to the main task lifecycle
 * pipeline.  Each writeback function is idempotent (keyed on task_id+role)
 * and non-blocking (failures are caught and returned, never thrown).
 *
 * Supports the following roles, matching ARTIFACT_SCHEMA.required_by_role:
 *   builder, verifier, reviewer, finalizer, integrator, repairer, context_curator
 */

import { createAgentRun, completeAgentRun, listAgentRuns } from "./agent-run-service.mjs";
import { normalizeContractRole } from "./agent-artifact-contract.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function string(value, fallback = "") {
  return String(value ?? fallback);
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Idempotent agent-run writeback
// ---------------------------------------------------------------------------

/**
 * Idempotent agent run writeback.
 *
 * Dedup key is (task_id, canonicalRole).  The function:
 * 1. Checks for an existing run with the same task_id and role.
 * 2. If one exists and is already completed/skipped, skips creation.
 * 3. If one exists but is not yet complete, completes it with new data.
 * 4. Otherwise creates a new run and immediately completes it.
 *
 * All errors are caught and returned in the result object (non-blocking).
 *
 * @param {object} store         - State store with mutate/load
 * @param {object} args
 * @param {string} args.task_id
 * @param {string} [args.goal_id]
 * @param {string} args.role     - Canonical agent role
 * @param {string} [args.status]  - "completed" | "failed" | "running"
 * @param {Array}  [args.output_artifacts]
 * @param {string} [args.summary]
 * @param {object} [context]     - { eventLogger, hookBus }
 * @returns {Promise<{skipped?:boolean, created?:boolean, updated?:boolean, agent_run?:object, role:string, reason?:string}>}
 */
export async function writeIdempotentAgentRun(store, args = {}, context = {}) {
  const { task_id, goal_id, role, status = "completed", output_artifacts = [], summary = "" } = args;
  if (!task_id) return { skipped: true, reason: "no task_id", role: role || "unknown" };

  const canonicalRole = normalizeContractRole(role, "builder");

  try {
    // Check for existing run with same task_id + role
    const existing = await listAgentRuns(store, { task_id, role: canonicalRole, limit: 1 });
    const existingRun = existing.agent_runs?.[0];

    if (existingRun) {
      if (existingRun.status === "completed" || existingRun.status === "skipped") {
        // Already completed — skip to avoid duplicates
        return { skipped: true, reason: "already_completed", existing_run_id: existingRun.id, role: canonicalRole };
      }
      // Not yet completed — complete it with new data
      const mergedArtifacts = [
        ...list(existingRun.output_artifacts),
        ...list(output_artifacts),
      ];
      const result = await completeAgentRun(store, {
        agent_run_id: existingRun.id,
        status,
        output_artifacts: mergedArtifacts,
        summary: summary || existingRun.summary || "",
      }, { eventLogger: context.eventLogger, hookBus: context.hookBus });
      return { created: false, updated: true, agent_run: result.agent_run, role: canonicalRole };
    }

    // Create new run
    const result = await createAgentRun(store, {
      task_id,
      goal_id: goal_id || "",
      role: canonicalRole,
      status: "running",
      output_artifacts: list(output_artifacts),
      summary,
    }, { eventLogger: context.eventLogger, hookBus: context.hookBus });

    // Immediately complete it unless caller explicitly wants a running state
    if (status === "completed" || status === "failed") {
      const completed = await completeAgentRun(store, {
        agent_run_id: result.agent_run.id,
        status,
        output_artifacts: list(output_artifacts),
        summary,
      }, { eventLogger: context.eventLogger, hookBus: context.hookBus });
      return { created: true, agent_run: completed.agent_run, role: canonicalRole };
    }

    return { created: true, agent_run: result.agent_run, role: canonicalRole };
  } catch (err) {
    // Non-blocking: don't fail the pipeline
    return { skipped: true, reason: string(err.message), error: true, role: canonicalRole };
  }
}

// ---------------------------------------------------------------------------
// Role-specific writeback functions
// ---------------------------------------------------------------------------

/**
 * Write a builder agent_run after Codex execution.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.taskResult]  - Parsed Codex result
 * @param {string} [opts.summary]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeBuilderAgentRun(store, { task_id, goal_id, taskResult = {}, summary = "" } = {}, context = {}) {
  const outputArtifacts = [];
  const changedFiles = list(taskResult.changed_files || taskResult.changedFiles);
  if (changedFiles.length > 0) {
    outputArtifacts.push({ kind: "change_summary", path: null, changed_count: changedFiles.length });
  }
  if (taskResult.commit) {
    outputArtifacts.push({ kind: "change_summary", path: null, commit: taskResult.commit });
  }
  const builderStatus = taskResult.status === "completed" || summary ? "completed" : "failed";
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "builder",
    status: builderStatus,
    output_artifacts: outputArtifacts,
    summary: summary || taskResult.summary || "Builder completed",
  }, context);
}

/**
 * Write a verifier agent_run after verification.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.verification]  - Verification result
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeVerifierAgentRun(store, { task_id, goal_id, verification = {} } = {}, context = {}) {
  const outputArtifacts = [];
  const commands = list(verification.commands);
  if (commands.length > 0) {
    outputArtifacts.push({ kind: "verification", path: null, commands_count: commands.length, passed: verification.passed === true });
  }
  const verifierStatus = verification.passed === true ? "completed" : "failed";
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "verifier",
    status: verifierStatus,
    output_artifacts: outputArtifacts,
    summary: verifierStatus === "completed" ? "Verification passed" : `Verification failed: ${verification.failure_class || "unknown"}`,
  }, context);
}

/**
 * Write a reviewer agent_run after acceptance / reviewer decision.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.reviewer_decision]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeReviewerAgentRun(store, { task_id, goal_id, reviewer_decision = {} } = {}, context = {}) {
  const decision = object(reviewer_decision.decision || reviewer_decision);
  const accepted = decision.passed === true || decision.status === "accepted" || decision.decision === "accepted";
  const outputArtifacts = [{ kind: "reviewer_decision", path: null, passed: accepted, status: decision.status || "unknown" }];
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "reviewer",
    status: accepted ? "completed" : "failed",
    output_artifacts: outputArtifacts,
    summary: accepted ? "Reviewer accepted" : "Reviewer did not accept",
  }, context);
}

/**
 * Write a finalizer agent_run after finalization / closure.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.taskResult]
 * @param {string} [opts.taskStatus]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeFinalizerAgentRun(store, { task_id, goal_id, taskResult = {}, taskStatus = "" } = {}, context = {}) {
  const finalStatus = taskStatus || taskResult.status || "completed";
  const outputArtifacts = [{ kind: "result", path: null, status: finalStatus }];
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "finalizer",
    status: finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "failed" : "completed",
    output_artifacts: outputArtifacts,
    summary: taskResult.summary || taskResult.reason || `Task ${finalStatus}`,
  }, context);
}

/**
 * Write an integrator agent_run after integration.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.integrationResult]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeIntegratorAgentRun(store, { task_id, goal_id, integrationResult = {} } = {}, context = {}) {
  const status = String(integrationResult.status || "");
  const merged = integrationResult.merged === true
    || ["merged", "ff_only_merged", "skipped", "not_required"].includes(status);
  const outputArtifacts = [{ kind: "integration", path: null, status, merged }];
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "integrator",
    status: merged ? "completed" : "failed",
    output_artifacts: outputArtifacts,
    summary: merged ? `Integration ${status || "complete"}` : `Integration failed: ${status}`,
  }, context);
}

/**
 * Write a repairer agent_run after repair attempt.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.repairOutcome]
 * @param {boolean} [opts.repairOutcome.passed]
 * @param {string} [opts.repairOutcome.repair_outcome]
 * @param {string} [opts.repairOutcome.reason]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeRepairerAgentRun(store, { task_id, goal_id, repairOutcome = {} } = {}, context = {}) {
  const passed = repairOutcome.passed === true || repairOutcome.repair_outcome === "repaired";
  const outputArtifacts = [{ kind: "repair", path: null, passed, outcome: repairOutcome.repair_outcome || "unknown" }];
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "repairer",
    status: passed ? "completed" : "failed",
    output_artifacts: outputArtifacts,
    summary: passed ? `Repair successful: ${repairOutcome.reason || "repaired"}` : `Repair failed: ${repairOutcome.reason || "unknown"}`,
  }, context);
}

/**
 * Write a context_curator agent_run.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.artifacts]  - Map of artifact name => { path, required, present }
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writeContextCuratorAgentRun(store, { task_id, goal_id, artifacts = {} } = {}, context = {}) {
  const outputArtifacts = [];
  for (const [name, info] of Object.entries(artifacts)) {
    if (info && info.present !== false) {
      outputArtifacts.push({
        kind: name,
        path: info.path || null,
        required: info.required === true,
      });
    }
  }
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "context_curator",
    status: "completed",
    output_artifacts: outputArtifacts,
    summary: "Context bundle prepared",
  }, context);
}

// ---------------------------------------------------------------------------
// Batch writeback helpers
// ---------------------------------------------------------------------------

/**
 * Run multiple writebacks concurrently, all non-blocking.
 *
 * @param {object} store
 * @param {Array<{fn: Function, opts: object}>} writebacks
 * @param {object} [context]
 * @returns {Promise<Array<object>>}
 */
export async function writeAllAgentRuns(store, writebacks = [], context = {}) {
  return Promise.allSettled(
    writebacks.map(({ fn, opts }) => {
      if (typeof fn !== "function") return Promise.resolve({ skipped: true, reason: "no function" });
      try {
        return fn(store, opts, context);
      } catch (err) {
        return Promise.resolve({ skipped: true, reason: string(err.message), error: true });
      }
    })
  );
}
