/**
 * execution-pipeline-adapter.mjs — Concrete ExecutionRun pipeline.
 *
 * Wires the execution-core abstraction to the actual execution infrastructure:
 *
 *   ExecutionRun → Provider (start/observe/collect)
 *               → Evidence Bundle
 *               → Acceptance Decision
 *               → Run State Transition
 *               → Projection to Task/Goal/Workstream
 *
 * This adapter replaces the three parallel paths (execution/*, executions/*,
 * task-processing/*) with a single concrete path through ExecutionRun.
 *
 * @module execution-pipeline-adapter
 */

/**
 * Create the execution pipeline adapter.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @param {object} deps.providerRegistry - Provider registry (from execution/)
 * @param {object} [deps.acceptanceService] - Acceptance evaluation service
 * @param {object} [deps.projectionService] - Projection service
 * @param {object} [deps.evidenceService] - Evidence persistence
 * @param {object} [deps.eventStore] - Event store for logging
 * @param {object} [deps.supervisorPolicyEngine] - For checkpoint decisions
 * @returns {object} Pipeline adapter API
 */
export function createExecutionPipelineAdapter(deps) {
  if (!deps.runStore) throw new Error("runStore is required");
  if (!deps.providerRegistry) throw new Error("providerRegistry is required");

  /**
   * Execute a full provider cycle for a run: start → observe → collect.
   *
   * This is the concrete implementation of the abstract `attemptOrchestrator`
   * referenced by execution-run-service's advanceRun().
   *
   * @param {object} options
   * @param {object} options.run - The ExecutionRun
   * @param {object} [options.intent] - The ExecutionIntent
   * @param {object} [options.planNode] - A plan node from the SupervisorPlan
   * @param {object} [options.context] - Execution context
   * @param {object} [options.workspace] - Workspace reference
   * @returns {Promise<{ kind: string, raw_evidence: object, failure?: object }>}
   */
  async function executeProviderCycle({ run, intent = null, planNode = null, context = {}, workspace = null } = {}) {
    // Step 1: Select provider
    const providerName = run.supervision?.execution_mode === "native_tui" ? "codex_tui" : "codex_exec";
    const provider = deps.providerRegistry.get(providerName);
    if (!provider) {
      return { kind: "failed", failure: { code: "provider_unavailable", message: `Provider ${providerName} not registered` } };
    }

    // Step 2: Start execution
    let handle;
    try {
      handle = await provider.start({ id: run.id, task_id: run.task_id }, context);
    } catch (err) {
      return { kind: "failed", failure: { code: "provider_start_failed", message: err.message } };
    }

    // Step 3: Observe until terminal or evidence ready
    let observation;
    const deadline = Date.now() + 300_000; // 5 min max
    while (Date.now() < deadline) {
      try {
        observation = await provider.observe(handle, context);
      } catch (err) {
        return { kind: "failed", failure: { code: "provider_observe_failed", message: err.message } };
      }

      if (observation.state === "evidence_ready") break;
      if (observation.state === "failed") {
        return { kind: "failed", failure: observation.failure || { code: "provider_execution_failed" } };
      }
      if (observation.state === "supervisor_required") {
        return { kind: "supervisor_required", reason: observation.checkpoint?.reason || "Supervisor intervention required", checkpoint: observation.checkpoint };
      }

      // Wait before polling again
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!observation || observation.state !== "evidence_ready") {
      return { kind: "failed", failure: { code: "execution_timeout" } };
    }

    // Step 4: Collect evidence
    let evidence;
    try {
      evidence = await provider.collect(handle, context);
    } catch (err) {
      return { kind: "failed", failure: { code: "provider_collect_failed", message: err.message } };
    }

    // Normalize evidence if service available
    if (deps.evidenceService) {
      try {
        evidence = await deps.evidenceService.normalizeAndPersist({ run, rawEvidence: evidence });
      } catch {
        // Use raw evidence as fallback
      }
    }

    return { kind: "evidence_ready", raw_evidence: evidence, provider_handle: handle };
  }

  /**
   * Evaluate evidence against acceptance criteria and decide next action.
   *
   * @param {object} options
   * @param {object} options.run
   * @param {object} [options.intent]
   * @param {object} [options.evidence]
   * @returns {Promise<{ decision: string, summary: string, missing_items?: string[], rejected_claims?: string[] }>}
   */
  async function evaluateAcceptance({ run, intent = null, evidence = null } = {}) {
    if (deps.acceptanceService) {
      return deps.acceptanceService.evaluate({ run, intent, evidence });
    }

    // Default acceptance: accept if evidence exists
    if (evidence) {
      return { decision: "accepted", summary: "Evidence collected, accepted by default" };
    }
    return { decision: "repair_required", summary: "No evidence collected" };
  }

  /**
   * Run a complete pipeline cycle for a run:
   *   1. Execute provider (start → observe → collect)
   *   2. Evaluate acceptance
   *   3. Transition run state
   *   4. Project to downstream entities
   *
   * @param {object} options
   * @param {object} options.run
   * @param {object} [options.intent]
   * @param {object} [options.plan]
   * @returns {Promise<{ pipeline_complete: boolean, final_state: string, error?: string }>}
   */
  async function runPipelineCycle({ run, intent = null, plan = null } = {}) {
    const pipelineResult = { pipeline_complete: false, final_state: run.state, error: null };

    try {
      // Step 1: Provider cycle
      const cycleResult = await executeProviderCycle({
        run,
        intent,
        context: { task: { id: run.task_id }, goal: { id: run.goal_id } },
      });

      if (cycleResult.kind === "failed") {
        // Log failure event
        if (deps.eventStore) {
          await deps.eventStore.appendEvent({
            run_id: run.id,
            type: "pipeline_execution_failed",
            severity: "error",
            data: { failure: cycleResult.failure },
          });
        }
        pipelineResult.error = cycleResult.failure?.message || "Provider execution failed";
        return pipelineResult;
      }

      if (cycleResult.kind === "supervisor_required") {
        pipelineResult.final_state = "waiting_for_supervisor";
        pipelineResult.error = cycleResult.reason;
        return pipelineResult;
      }

      // Step 2: Persist evidence
      const evidence = cycleResult.raw_evidence;
      if (deps.evidenceService && evidence) {
        const normalized = await deps.evidenceService.normalizeAndPersist({ run, rawEvidence: evidence });
        if (normalized?.id) {
          await deps.runStore.updateRun(run.id, { evidence_bundle_id: normalized.id });
        }
      }

      // Step 3: Evaluate acceptance
      const acceptanceResult = await evaluateAcceptance({ run, intent, evidence });
      await deps.runStore.updateRun(run.id, { acceptance_decision_id: acceptanceResult.id || null });

      switch (acceptanceResult.decision) {
        case "accepted":
          pipelineResult.final_state = "completed";
          break;
        case "repair_required":
          pipelineResult.final_state = "waiting_for_repair";
          pipelineResult.error = acceptanceResult.summary;
          break;
        case "review_required":
          pipelineResult.final_state = "waiting_for_review";
          pipelineResult.error = acceptanceResult.summary;
          break;
        case "supervisor_required":
          pipelineResult.final_state = "waiting_for_supervisor";
          pipelineResult.error = acceptanceResult.summary;
          break;
        default:
          pipelineResult.final_state = "failed";
          pipelineResult.error = `Unexpected acceptance decision: ${acceptanceResult.decision}`;
      }

      pipelineResult.pipeline_complete = true;

      // Step 4: Project to downstream entities
      if (deps.projectionService) {
        const updatedRun = await deps.runStore.readRun(run.id);
        await deps.projectionService.project(updatedRun).catch(() => {});
      }

    } catch (err) {
      pipelineResult.error = err.message;
    }

    return pipelineResult;
  }

  return { executeProviderCycle, evaluateAcceptance, runPipelineCycle };
}
