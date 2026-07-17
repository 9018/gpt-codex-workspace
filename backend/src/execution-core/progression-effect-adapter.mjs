/**
 * progression-effect-adapter.mjs — Progression effect adapter.
 *
 * Translates canonical AcceptanceDecisions into progression commands
 * that act on Tasks, Goals, Workstreams, and Queues.
 *
 * Per the plan (section 12):
 *   Canonical Decision → Progression Command → Task/Goal/Queue/Integration Effects
 *
 * @module progression-effect-adapter
 */

/**
 * Create the progression effect adapter.
 *
 * @param {object} deps
 * @param {object} [deps.progressionCommandBuilder] - Builds progression commands
 * @param {object} [deps.progressionCommandActuator] - Executes progression commands
 * @param {object} [deps.runStore] - ExecutionRun store
 * @returns {object} Progression effect API
 */
export function createProgressionEffectAdapter(deps = {}) {
  /**
   * Apply the effects of a canonical acceptance decision.
   * Translates the decision into progression commands and registers
   * pending effects on the run if the commands cannot be executed immediately.
   *
   * @param {object} options
   * @param {object} options.run - ExecutionRun
   * @param {object} options.decision - Canonical AcceptanceDecision
   * @returns {Promise<{ effects_applied: boolean, pending_effects: object[], errors?: string[] }>}
   */
  async function applyDecisionEffects({ run, decision } = {}) {
    if (!run) throw new Error("run is required");
    if (!decision) throw new Error("decision is required");

    const effects = [];
    const errors = [];

    switch (decision.decision) {
      case "accepted": {
        // Effects for accepted run: mark task complete, propagate goal, advance queue
        const completionEffect = {
          type: "complete_task",
          run_id: run.id,
          run_version: run.version,
          task_id: run.task_id,
          goal_id: run.goal_id,
          decision_summary: decision.summary,
          idempotency_key: `complete:${run.id}:${run.version}`,
        };
        effects.push(completionEffect);

        if (run.goal_id) {
          effects.push({
            type: "propagate_goal",
            run_id: run.id,
            goal_id: run.goal_id,
            idempotency_key: `propagate:${run.id}:${run.goal_id}`,
          });
        }
        break;
      }

      case "repair_required": {
        effects.push({
          type: "create_repair_task",
          run_id: run.id,
          task_id: run.task_id,
          missing_items: decision.missing_items || [],
          reason: decision.summary,
          idempotency_key: `repair:${run.id}:${run.version}`,
        });
        break;
      }

      case "review_required": {
        effects.push({
          type: "request_review",
          run_id: run.id,
          task_id: run.task_id,
          reason: decision.summary || "Review required",
          idempotency_key: `review:${run.id}:${run.version}`,
        });
        break;
      }

      case "supervisor_required": {
        effects.push({
          type: "request_supervisor",
          run_id: run.id,
          task_id: run.task_id,
          reason: decision.summary || "Supervisor intervention required",
          idempotency_key: `supervisor_req:${run.id}:${run.version}`,
        });
        break;
      }

      default: {
        errors.push(`Unknown decision type: ${decision.decision}`);
      }
    }

    // Attempt to execute progression commands immediately if builders available
    let effectsApplied = false;
    if (deps.progressionCommandBuilder && deps.progressionCommandActuator) {
      let allApplied = true;
      for (const effect of effects) {
        try {
          const command = await buildProgressionCommand(effect);
          if (command) {
            await deps.progressionCommandActuator.execute(command);
          }
        } catch (err) {
          allApplied = false;
          errors.push(`Failed to apply effect ${effect.type}: ${err.message}`);
        }
      }
      effectsApplied = allApplied;
    }

    // Register pending effects on the run for retry
    if (deps.runStore && !effectsApplied && effects.length > 0) {
      try {
        const currentRun = await deps.runStore.readRun(run.id);
        await deps.runStore.updateRun(run.id, {
          pending_effects: [...(currentRun.pending_effects || []), ...effects],
        });
      } catch {
        // Non-fatal
      }
    }

    return { effects_applied: effectsApplied, pending_effects: effects, errors };
  }

  /**
   * Build a progression command from an effect descriptor.
   * Delegates to the existing progression command builder when available.
   */
  async function buildProgressionCommand(effect) {
    if (deps.progressionCommandBuilder && effect.type) {
      const actionMap = {
        complete_task: "complete_task",
        propagate_goal: "propagate_goal",
        create_repair_task: "queue_repair_task",
        request_review: "complete_task",
        request_supervisor: "complete_task",
      };
      const action = actionMap[effect.type];
      if (action) {
        return deps.progressionCommandBuilder.build({
          action,
          payload: effect,
          idempotencyKey: effect.idempotency_key,
        });
      }
    }
    return null;
  }

  return { applyDecisionEffects, buildProgressionCommand };
}
