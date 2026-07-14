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
      if (existingRun.status === "skipped") {
        return { skipped: true, reason: "already_skipped", existing_run_id: existingRun.id, role: canonicalRole };
      }
      // A pipeline run may already be marked completed before role-specific
      // writeback supplies its contract artifact. Merge evidence even for a
      // completed run; otherwise gate evaluation remains permanently blocked.
      const existingArtifacts = list(existingRun.output_artifacts);
      const enrichedArtifacts = list(output_artifacts).map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
        if (existingRun.require_fresh_artifacts !== true) return candidate;
        const metadata = { ...(candidate.metadata || {}) };
        if (existingRun.input_context_digest) metadata.context_digest ||= existingRun.input_context_digest;
        if (existingRun.expected_head) metadata.git ||= { output_head: existingRun.expected_head };
        if (existingRun.expected_input_artifact_digests && Object.keys(existingRun.expected_input_artifact_digests).length > 0) {
          metadata.input_artifact_digests ||= existingRun.expected_input_artifact_digests;
        }
        return { ...candidate, metadata };
      });
      const additions = enrichedArtifacts.filter((candidate) => {
        const candidateKind = candidate && typeof candidate === "object" ? candidate.kind : candidate;
        return !existingArtifacts.some((artifact) => {
          const artifactKind = artifact && typeof artifact === "object" ? artifact.kind : artifact;
          return artifactKind === candidateKind;
        });
      });
      if (existingRun.status === "completed" && additions.length === 0) {
        return { skipped: true, reason: "already_completed", existing_run_id: existingRun.id, role: canonicalRole };
      }
      const mergedArtifacts = [...existingArtifacts, ...additions];
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
  // P0-MA11: Always include change_summary artifact for contract validation
  outputArtifacts.push({
    kind: "change_summary",
    path: null,
    changed_count: changedFiles.length,
    commit: taskResult.commit || null,
    failure_class: taskResult.failure_class || null,
  });
  const builderFailed = taskResult.failure_class === "codex_transport_404"
    || taskResult.status === "blocked";
  const builderStatus = builderFailed ? "failed" : (taskResult.status === "completed" || summary ? "completed" : "failed");
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
  const commandsMissing = commands.length === 0;
  const passedWithEvidence = verification.passed === true && !commandsMissing;
  const failureClass = commandsMissing ? "verification_commands_missing" : (verification.failure_class || "unknown");

  // P0: a verifier run is only complete when it has concrete command evidence.
  // This prevents a false-positive chain where verifier passes with
  // commands_count=0 and reviewer/integrator/finalizer later fail with no
  // actionable evidence.
  outputArtifacts.push({
    kind: "verification",
    path: null,
    commands_count: commands.length,
    passed: passedWithEvidence,
    failure_class: passedWithEvidence ? null : failureClass,
    missing_evidence: commandsMissing ? ["verification.commands"] : [],
    findings: commandsMissing ? [{
      severity: "blocker",
      code: "verification_commands_missing",
      message: "Verifier produced commands_count=0; at least one executable verification command is required.",
      source: "agent_run_writeback",
    }] : list(verification.findings),
    next_action: commandsMissing
      ? "Configure and run at least one verification command, then rerun verification."
      : (verification.next_action || null),
  });
  const verifierStatus = passedWithEvidence ? "completed" : "failed";
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: "verifier",
    status: verifierStatus,
    output_artifacts: outputArtifacts,
    summary: verifierStatus === "completed" ? "Verification passed" : `Verification failed: ${failureClass}`,
  }, context);
}

export async function skipDownstreamAgentRunsForBlocker(store, {
  task_id,
  goal_id,
  finding = {},
  next_action = "",
  roles = ["verifier", "reviewer", "integrator"],
} = {}, context = {}) {
  if (!task_id) return { roles: [], skipped: 0, reason: "no task_id" };
  const existing = await listAgentRuns(store, { task_id, limit: 100 });
  const runs = existing.agent_runs || [];
  let skipped = 0;

  for (const role of roles) {
    const canonicalRole = normalizeContractRole(role);
    let run = runs.find((entry) => normalizeContractRole(entry.role) === canonicalRole);
    if (run?.status === "completed" || run?.status === "skipped") continue;
    if (!run) {
      const created = await createAgentRun(store, {
        task_id,
        goal_id: goal_id || "",
        role: canonicalRole,
        status: "queued",
      }, context);
      run = created.agent_run;
    }
    await completeAgentRun(store, {
      agent_run_id: run.id,
      status: "skipped",
      output_artifacts: [{
        kind: "pipeline_blocker",
        severity: finding.severity || "blocker",
        code: finding.code || "pipeline_halted",
        message: finding.message || "Downstream pipeline halted by an actionable blocker.",
        source: finding.source || "pipeline_orchestration",
        next_action: next_action || null,
      }],
      summary: `${canonicalRole}: skipped because ${finding.code || "pipeline_halted"}`,
    }, context);
    skipped += 1;
  }

  return { roles: roles.map((role) => normalizeContractRole(role)), skipped };
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
  // P0-MA11: Check all decision formats
  const raw = object(reviewer_decision.decision || reviewer_decision);
  // Handle string decision values like "accepted"
  const decision = typeof raw === "string" ? {} : raw;
  const accepted = reviewer_decision.passed === true
    || reviewer_decision.status === "accepted"
    || reviewer_decision.decision === "accepted"
    || reviewer_decision.decision?.passed === true
    || reviewer_decision.decision?.status === "accepted"
    || decision.passed === true
    || decision.status === "accepted"
    || decision.decision === "accepted";
  const decisionStatus = typeof reviewer_decision.status === "string" ? reviewer_decision.status : (decision.status || "unknown");
  const outputArtifacts = [{ kind: "reviewer_decision", path: null, passed: accepted, status: decisionStatus }];
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
/**
 * Write a planner agent_run.
 * Planner's work is already represented by existing context/prompt files.
 *
 * @param {object} store
 * @param {object} opts
 * @param {string} opts.task_id
 * @param {string} [opts.goal_id]
 * @param {object} [opts.planEvidence]  - Map of plan evidence artifacts
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function writePlannerAgentRun(store, { task_id, goal_id, planEvidence = {} } = {}, context = {}) {
  const outputArtifacts = [];
  for (const [name, info] of Object.entries(planEvidence)) {
    if (info && info.present !== false) {
      outputArtifacts.push({
        kind: name,
        path: info.path || null,
        required: info.required === true,
      });
    }
  }
  // Always include a plan placeholder artifact for contract validation
  outputArtifacts.push({
    kind: 'plan',
    path: null,
    present: Object.keys(planEvidence).length > 0,
  });
  return writeIdempotentAgentRun(store, {
    task_id, goal_id, role: 'planner',
    status: 'completed',
    output_artifacts: outputArtifacts,
    summary: 'Plan determined from context/prompt files',
  }, context);
}

// ---------------------------------------------------------------------------
// Batch completion: complete queued agent runs from task result evidence
// ---------------------------------------------------------------------------

/**
 * Complete all queued agent_runs for a task that has already produced
 * result evidence. This prevents agent_runs from staying queued forever
 * for completed tasks.
 *
 * Context curator and planner are completed/skipped deterministically.
 * Builder/verifier/reviewer/integrator/finalizer are completed from
 * existing taskResult evidence.
 *
 * @param {object} store
 * @param {object} args
 * @param {string} args.task_id
 * @param {string} [args.goal_id]
 * @param {object} [args.taskResult] - Existing task result (if any)
 * @param {object} [context]
 * @returns {Promise<{completed: number, skipped: number, reasons: string[]}>}
 */
export async function completeQueuedAgentRuns(store, { task_id, goal_id, taskResult = {} } = {}, context = {}) {
  const { listAgentRuns } = await import('./agent-run-service.mjs');
  const result = await listAgentRuns(store, { task_id, limit: 100 });
  const agentRuns = result.agent_runs || [];
  const queued = agentRuns.filter(r => r.status === 'queued');

  if (queued.length === 0) {
    return { completed: 0, skipped: agentRuns.length, reasons: ['no_queued_runs'] };
  }

  let completed = 0;
  const reasons = [];

  for (const run of queued) {
    const role = normalizeContractRole(run.role);
    const existingEvidence = Boolean(taskResult && Object.keys(taskResult).length > 0);

    try {
      if (role === 'context_curator' || role === 'planner') {
        // Deterministically skip — their work is represented by existing files
        const { completeAgentRun } = await import('./agent-run-service.mjs');
        await completeAgentRun(store, {
          agent_run_id: run.id,
          status: 'completed',
          output_artifacts: [{ kind: role === 'context_curator' ? 'context_bundle' : 'plan', path: null, present: true, auto_completed: true }],
          summary: role === 'context_curator' ? 'Context bundle prepared (auto-completed)' : 'Plan determined from context (auto-completed)',
        }, context);
        completed++;
        reasons.push(role + ": auto-completed from task result");
      } else if (existingEvidence) {
        // Complete from task result evidence. Verifier evidence is special:
        // it must include at least one concrete command, otherwise the queued
        // verifier is failed instead of falsely auto-completed. This keeps the
        // reviewer/integrator/finalizer chain from advancing on commands_count=0.
        if (role === 'verifier') {
          await writeVerifierAgentRun(store, {
            task_id, goal_id,
            verification: taskResult.verification || {},
          }, context);
        } else {
          await writeIdempotentAgentRun(store, {
            task_id, goal_id, role,
            status: 'completed',
            output_artifacts: buildRoleOutputArtifacts(role, taskResult),
            summary: role + ": completed from task result evidence",
          }, context);
        }
        completed++;
        reasons.push(role + ": auto-completed from task result");
      } else {
        // No evidence — mark skipped
        const { completeAgentRun } = await import('./agent-run-service.mjs');
        await completeAgentRun(store, {
          agent_run_id: run.id,
          status: 'skipped',
          output_artifacts: [],
          summary: role + ": skipped - no evidence",
        }, context);
        completed++;
        reasons.push(role + ": auto-completed from task result");
      }
    } catch (err) {
      reasons.push(role + ": auto-completion error: " + (err.message || String(err)));
    }
  }

  return { completed, skipped: agentRuns.length - queued.length, reasons };
}

// ---------------------------------------------------------------------------
// Internal: build role-specific output artifacts from task result
// ---------------------------------------------------------------------------

function buildRoleOutputArtifacts(role, taskResult = {}) {
  const artifacts = [];

  switch (role) {
    case 'builder': {
      const changedFiles = list(taskResult.changed_files || taskResult.changedFiles);
      artifacts.push({ kind: 'change_summary', path: null, changed_count: changedFiles.length, commit: taskResult.commit || null });
      break;
    }
    case 'verifier': {
      const verification = taskResult.verification || {};
      artifacts.push({ kind: 'verification', path: null, commands_count: list(verification.commands).length, passed: verification.passed === true });
      break;
    }
    case 'reviewer': {
      const rd = taskResult.reviewer_decision || {};
      const accepted = rd.passed === true || rd.status === 'accepted' || rd.decision === 'accepted';
      artifacts.push({ kind: 'reviewer_decision', path: null, passed: accepted, status: rd.status || 'unknown' });
      break;
    }
    case 'integrator': {
      const integration = taskResult.integration || {};
      const merged = integration.merged === true || ['merged', 'ff_only_merged', 'skipped', 'not_required', 'already_integrated'].includes(String(integration.status));
      artifacts.push({ kind: 'integration', path: null, status: integration.status || 'unknown', merged });
      break;
    }
    case 'finalizer': {
      const finalStatus = taskResult.status || 'completed';
      artifacts.push({ kind: 'result', path: null, status: finalStatus });
      break;
    }
    default:
      artifacts.push({ kind: role, path: null, auto_completed: true });
  }

  return artifacts;
}

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
