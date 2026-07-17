/**
 * execution-run-service.mjs — Central orchestrator for ExecutionRun lifecycle.
 *
 * @module execution-run-service
 */

import { assertAllowedTransition } from "./execution-state-machine.mjs";
import { randomUUID } from "node:crypto";

/**
 * Create the ExecutionRun service.
 */
export function createExecutionRunService(deps) {
  if (!deps.runStore) throw new Error("runStore is required");

  async function start(request) {
    const intent = request.intent || await deps.intentStore?.read(request.intent_id);

    // Check idempotency: same idempotency_key returns existing run
    if (request.idempotency_key && !request.force_new_run) {
      const existing = await deps.runStore.findRunByIdempotencyKey(request.idempotency_key);
      if (existing) {
        return { run: existing, started: true, idempotent: true };
      }
    }

    // Check request_id idempotency
    if (request.request_id && !request.force_new_run) {
      const existing = await deps.runStore.findRunByRequestId(request.request_id);
      if (existing) {
        return { run: existing, started: true, idempotent: true };
      }
    }

    let run = await deps.runStore.createRun({
      intent_id: intent?.id || request.intent_id,
      request_id: request.request_id || null,
      idempotency_key: request.idempotency_key || null,
      goal_id: request.goal_id,
      task_id: request.task_id,
      workstream_id: request.workstream_id,
    });

    // Attempts are created by advanceRun(), not start().
    // start() only creates the run; first execution attempt is created on first advanceRun().
    try {
      run = await transition(run, "created", "planning");

      const plan = deps.planCompiler ? await deps.planCompiler.compile(intent) : null;
      const workspace = deps.workspaceService
        ? await deps.workspaceService.prepare({ run, intent, plan })
        : null;
      const context = deps.contextService
        ? await deps.contextService.build({ run, intent, plan, workspace })
        : { id: `${run.id}:ctx` };

      run = await deps.runStore.updateRun(run.id, {
        plan_id: plan?.id || null,
        workspace_ref: workspace?.id || null,
        context_ref: context.id,
      });

      run = await transition(run, "planning", "ready");

      await safeProject(run);

      return { run, started: true };
    } catch (error) {
      try {
        run = await deps.runStore.updateRun(run.id, {
          failure: { code: "startup_failed", message: error.message },
        });
        run = await transition(run, run.state, "failed").catch(() => run);
      } catch {
        // Ignore errors during cleanup
      }
      try {
        await safeProject(run);
      } catch {
        // Ignore projection errors during cleanup
      }
      return { run, started: false, error };
    }
  }

  async function read(runId) {
    return deps.runStore.readRun(runId);
  }

  async function advanceRun(runId) {
    let run = await deps.runStore.readRun(runId);
    run = await transitionAny(run, ["ready", "running", "resuming", "correcting"], "running");

    const plan = deps.planCompiler ? await deps.planCompiler.load(run.plan_id) : null;
    const intent = deps.intentStore ? await deps.intentStore.read(run.intent_id) : null;
    const context = deps.contextService ? await deps.contextService.load(run.context_ref) : null;
    const workspace = deps.workspaceService ? await deps.workspaceService.load(run.workspace_ref) : null;

    // Record a new attempt for each execution cycle
    const attemptNumber = (run.attempt_ids?.length || 0) + 1;
    run = await createRunAttempt(run, { attemptNumber, plan_id: plan?.id || null });

    const outcome = deps.attemptOrchestrator
      ? await deps.attemptOrchestrator.execute({
          run,
          intent,
          planNode: plan?.nodes?.[0] || { id: "default" },
          context,
          workspace,
        })
      : { kind: "evidence_ready", raw_evidence: { provider_claims: [] } };

    if (outcome.kind === "failed") {
      run = await handleAttemptFailure(run, outcome);
      return { run, outcome };
    }

    if (outcome.kind === "supervisor_required") {
      run = await pauseForSupervisor(run, outcome);
      return { run, outcome };
    }

    run = await transition(run, "running", "collecting");

    const evidence = deps.evidenceService
      ? await deps.evidenceService.normalizeAndPersist({
          run,
          rawEvidence: outcome.raw_evidence,
        })
      : null;

    run = await deps.runStore.updateRun(run.id, {
      evidence_bundle_id: evidence?.id || null,
    });

    run = await transition(run, "collecting", "evaluating");

    // Evaluate acceptance — REQUIRED. No bypass path.
    run = await evaluateRunInternal(run, intent, plan, evidence);

    await safeProject(run);

    return { run, outcome: { kind: run.state === "completed" ? "completed" : "evaluated" } };
  }

  /**
   * Internal evaluation logic used by both advanceRun and evaluateRun.
   * Determines the next state based on acceptance decision.
   */
  async function evaluateRunInternal(run, intent, plan, evidence) {
    if (!deps.acceptanceService) {
      throw new Error("acceptanceService is required for mutable runs");
    }
    const decision = await deps.acceptanceService.evaluate({
      run,
      intent,
      plan,
      evidence,
    });

    run = await deps.runStore.updateRun(run.id, {
      acceptance_decision_id: decision.id || null,
    });

    // Create a pending effect record for the decision
    const pendingEffect = {
      type: "acceptance_decision",
      decision: decision.decision,
      run_id: run.id,
      run_version: run.version,
      idempotency_key: `acceptance:${run.id}:${run.version}`,
    };

    switch (decision.decision) {
      case "accepted": {
        // ===== Gate 1: Canonical decision — must pass all checks =====
        if (deps.canonicalAcceptanceAdapter) {
          const canonical = await deps.canonicalAcceptanceAdapter.evaluate({ run, intent, evidence });
          
          // 1a: If canonical adapter returns a different decision, respect it
          if (canonical.decision && canonical.decision !== "accepted") {
            decision.decision = canonical.decision;
            if (canonical.summary) decision.summary = canonical.summary;
            if (canonical.missing_items) decision.missing_items = canonical.missing_items;
            return evaluateRunInternal(run, intent, plan, evidence);
          }
          
          // 1b: Verify terminal readiness — canonical must confirm completion readiness
          //     "consistency_valid" means all acceptance criteria, integration checks,
          //     and closure conditions have been verified.
          //     If the canonical adapter doesn't return consistency_valid, treat as failed.
          if (!canonical.consistency_valid) {
            run = await deps.runStore.updateRun(run.id, {
              failure: { code: "canonical_inconsistency", message: "Canonical acceptance failed consistency validation" },
            });
            run = await transition(run, "evaluating", "failed");
            return run;
          }
        }

        // ===== Gate 2: Progression effects — must be durably enqueued =====
        if (deps.progressionEffectAdapter) {
          const progression = await deps.progressionEffectAdapter.applyDecisionEffects({
            run,
            decision: { decision: "accepted", summary: decision.summary },
          });
          
          //   Effects must be either applied or durably persisted as pending.
          //   Unrecoverable progression failures prevent completion.
          if (!progression.effects_applied) {
            if (progression.errors?.length) {
              // Fatal: enqueue itself failed
              run = await deps.runStore.updateRun(run.id, {
                failure: { code: "progression_fatal", message: progression.errors.join("; ") },
                pending_effects: [...(run.pending_effects || []), ...(progression.pending_effects || [])],
              });
              run = await transition(run, "evaluating", "failed");
              return run;
            }
            // Effects not applied but no errors. Check for durable pending effects.
            if (!progression.pending_effects?.length) {
              // No pending effects either → unrecoverable progression gap → fail closed
              run = await deps.runStore.updateRun(run.id, {
                failure: { code: "progression_gap", message: "Progression effects not applied and no pending effects" },
              });
              run = await transition(run, "evaluating", "failed");
              return run;
            }
            // Durable pending effects exist — attach to run, supervisor will reconcile
          }
        }

        // ===== Both gates passed: proceed to completed =====
        run = await deps.runStore.updateRun(run.id, {
          outcome: { status: "accepted", summary: decision.summary || "Accepted" },
        });
        run = await transition(run, "evaluating", "completed");
        break;
      }

      case "repair_required":
        run = await transition(run, "evaluating", "waiting_for_repair");
        run = await deps.runStore.updateRun(run.id, {
          failure: {
            code: "repair_required",
            message: decision.summary,
            missing_items: decision.missing_items,
          },
          pending_effects: [...(run.pending_effects || []), pendingEffect],
        });
        break;

      case "review_required":
        run = await transition(run, "evaluating", "waiting_for_review");
        run = await deps.runStore.updateRun(run.id, {
          pending_effects: [...(run.pending_effects || []), pendingEffect],
        });
        break;

      case "supervisor_required":
        run = await transition(run, "evaluating", "waiting_for_supervisor");
        run = await deps.runStore.updateRun(run.id, {
          supervision: {
            ...run.supervision,
            waiting_reason: decision.summary || "supervisor intervention required",
          },
          pending_effects: [...(run.pending_effects || []), pendingEffect],
        });
        break;

      case "rejected":
        run = await deps.runStore.updateRun(run.id, {
          failure: {
            code: "rejected",
            message: decision.summary || "evidence rejected",
            missing_items: decision.missing_items,
            rejected_claims: decision.rejected_claims,
          },
        });
        run = await transition(run, "evaluating", "failed");
        break;

      default:
        run = await deps.runStore.updateRun(run.id, {
          failure: {
            code: "unknown_acceptance_decision",
            message: `Unknown acceptance decision type: "${decision.decision}"`,
            original_decision: decision,
          },
        });
        run = await transition(run, "evaluating", "failed");
        break;
    }

    return run;
  }



  async function evaluateRun(runId) {
    let run = await deps.runStore.readRun(runId);

    // Must be in evaluating or collecting state to evaluate
    if (!["evaluating", "collecting"].includes(run.state)) {
      throw new Error(
        `Cannot evaluate run "${runId}" in state "${run.state}": must be in evaluating or collecting`
      );
    }

    if (run.state === "collecting") {
      run = await transition(run, "collecting", "evaluating");
    }

    const plan = deps.planCompiler ? await deps.planCompiler.load(run.plan_id) : null;
    const intent = deps.intentStore ? await deps.intentStore.read(run.intent_id) : null;
    const evidence = deps.evidenceService
      ? await deps.evidenceService.load(run.evidence_bundle_id)
      : null;
    run = await evaluateRunInternal(run, intent, plan, evidence);

    await safeProject(run);

    return { run };
  }

  async function requestStop({ runId, reason = "stop_requested" }) {
    await deps.runStore.readRun(runId);
    return { run_id: runId, stopped: true };
  }

  async function cancel({ runId, reason = "cancelled" }) {
    let run = await deps.runStore.readRun(runId);
    run = await transition(run, run.state, "cancelled");
    await safeProject(run);
    return { run };
  }

  async function collect({ runId }) {
    const run = await deps.runStore.readRun(runId);
    return { run_id: runId, evidence_bundle_id: run.evidence_bundle_id };
  }

  /**
   * Create a checkpoint for the run, transitioning to checkpointing.
   */
  async function checkpointRun({ runId, checkpoint }) {
    let run = await deps.runStore.readRun(runId);
    const allowedFrom = ["running", "evaluating", "waiting_for_repair", "waiting_for_review"];
    if (!allowedFrom.includes(run.state)) {
      throw new Error(
        `Cannot checkpoint run "${runId}" in state "${run.state}"`
      );
    }
    run = await transition(run, run.state, "checkpointing");

    if (checkpoint) {
      const checkpointStore = deps.checkpointStore;
      if (checkpointStore) {
        const persisted = await checkpointStore.createCheckpoint({
          run_id: run.id,
          ...checkpoint,
        });
        run = await deps.runStore.updateRun(run.id, {
          active_checkpoint_id: persisted.id,
          checkpoint_ids: [...(run.checkpoint_ids || []), persisted.id],
        });
      }
    }

    return { run };
  }

  // ---- Internal helpers ----

  async function transition(run, from, to) {
    assertAllowedTransition({
      from: typeof from === "string" ? from : run.state,
      to,
      metadata: { runId: run.id },
    });
    return deps.runStore.compareAndSetState({
      runId: run.id,
      expectedState: typeof from === "string" ? from : from.includes(run.state) ? run.state : from[0],
      nextState: to,
    });
  }

  async function transitionAny(run, allowedFromStates, to) {
    // Try each allowed from state until one works
    for (const from of allowedFromStates) {
      if (run.state === from) {
        return transition(run, from, to);
      }
    }
    // If run is already in the target state, return as-is
    if (run.state === to) return run;
    throw new Error(`Cannot transition from "${run.state}" to "${to}"`);
  }

  async function handleAttemptFailure(run, outcome) {
    // Update supervision tracking for failure signature
    const failureSignature = outcome.failure?.code || "attempt_failed";
    run = await deps.runStore.updateRun(run.id, {
      failure: outcome.failure || { code: "attempt_failed" },
      supervision: {
        ...(run.supervision || {}),
        last_failure_signature: failureSignature,
        same_failure_retries: (run.supervision?.same_failure_retries || 0) + 1,
      },
    });
    run = await transition(run, run.state, "failed");
    await safeProject(run);
    return run;
  }

  async function pauseForSupervisor(run, outcome) {
    // Map supervisor_required to waiting_for_supervisor (not waiting_for_repair)
    run = await transition(run, "running", "waiting_for_supervisor");
    run = await deps.runStore.updateRun(run.id, {
      supervision: {
        ...(run.supervision || {}),
        waiting_reason: outcome.reason || "supervisor intervention required",
      },
      pending_effects: [
        ...(run.pending_effects || []),
        {
          type: "supervisor_required",
          reason: outcome.reason || "supervisor intervention required",
          run_id: run.id,
          idempotency_key: `supervisor:${run.id}:${Date.now()}`,
        },
      ],
    });
    await safeProject(run);
    return run;
  }

  async function safeProject(run) {
    if (deps.projectionService) {
      try {
        await deps.projectionService.project(run);
      } catch (projectionError) {
        // Projection errors: create pending effect and write event
        const pendingEffect = {
          action: "reconcile_projection",
          run_id: run.id,
          run_version: run.version,
          idempotency_key: `projection:${run.id}:${run.version}`,
        };
        try {
          await deps.runStore.updateRun(run.id, {
            pending_effects: [...(run.pending_effects || []), pendingEffect],
          });
        } catch {
          // Ignore errors creating pending effect
        }
        if (deps.eventStore) {
          try {
            await deps.eventStore.appendEvent({
              run_id: run.id,
              type: "projection_failed",
              severity: "warning",
              data: { error: projectionError.message, run_version: run.version },
            });
          } catch {
            // Ignore event store errors
          }
        }
      }
    }
  }

  /**
   * Create an execution attempt and link it to the run.
   * If an attempt store is available and the run has a task_id,
   * a persistent attempt record is created. Otherwise, the
   * attempt_id is still tracked on the run for lineage.
   */
  async function createRunAttempt(run, { attemptNumber, plan_id = null } = {}) {
    const attemptId = `attempt_${randomUUID()}`;
    const patch = {};

    // If we have an attempt store and a task_id, create a persistent record
    if (deps.attemptStore && run.task_id) {
      try {
        const attempt = await deps.attemptStore.claim({
          taskId: run.task_id,
          goalId: run.goal_id,
          provider: "codex_tui",
          planId: plan_id,
          pathContext: run.path_context_ref ? { ref: run.path_context_ref } : null,
          inputSnapshot: { run_id: run.id, intent_id: run.intent_id },
        });
        if (attempt?.attempt) {
          patch.active_attempt_id = attempt.attempt.id;
          patch.attempt_ids = [...new Set([...(run.attempt_ids || []), attempt.attempt.id])];
          return deps.runStore.updateRun(run.id, patch);
        }
      } catch {
        // Attempt store failure is non-fatal; continue with generated ID
      }
    }

    // Fallback: track attempt by generated ID
    patch.active_attempt_id = attemptId;
    patch.attempt_ids = [...new Set([...(run.attempt_ids || []), attemptId])];
    return deps.runStore.updateRun(run.id, patch);
  }

  return {
    start,
    read,
    advanceRun,
    evaluateRun,
    requestStop,
    cancel,
    collect,
    checkpointRun,
  };
}
