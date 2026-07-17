/**
 * supervisor-context-packet.mjs — Context packet for supervisor handoff.
 *
 * Bundles the relevant context when handing off from Codex autopilot
 * to ChatGPT supervisor: run state, checkpoint history, evidence,
 * and policy decisions.
 *
 * @module supervisor-context-packet
 */

/**
 * Build a supervisor context packet for handoff.
 *
 * @param {object} options
 * @param {object} options.run - Current ExecutionRun
 * @param {object} [options.plan] - SupervisorPlan
 * @param {object[]} [options.checkpoints] - Recent checkpoint history
 * @param {object} [options.evidence] - Current evidence bundle
 * @param {object} [options.intent] - Original intent
 * @param {object} [options.latestCheckpoint] - Most recent checkpoint verdict
 * @returns {object} Context packet
 */
export function buildSupervisorContextPacket({
  run = {},
  plan = null,
  checkpoints = [],
  evidence = null,
  intent = null,
  latestCheckpoint = null,
} = {}) {
  return {
    schema_version: 1,
    built_at: new Date().toISOString(),
    run_summary: {
      id: run.id,
      state: run.state,
      intent_id: run.intent_id,
      goal_id: run.goal_id,
      task_id: run.task_id,
      version: run.version,
      failure: run.failure,
      outcome: run.outcome,
    },
    supervision: run.supervision ? { ...run.supervision } : null,
    plan: plan ? {
      id: plan.id,
      user_goal: plan.user_goal,
      execution_steps: plan.execution_steps?.length,
      autonomy_budget: plan.autonomy_budget,
      takeover_policy: plan.takeover_policy,
    } : null,
    checkpoints: checkpoints.map((cp) => ({
      id: cp.id,
      trigger_source: cp.trigger_source,
      verdict: cp.verdict,
      action: cp.action,
      created_at: cp.created_at,
    })),
    latest_checkpoint: latestCheckpoint ? {
      verdict: latestCheckpoint.verdict,
      action: latestCheckpoint.action,
      trigger_source: latestCheckpoint.trigger_source,
      reasoning: latestCheckpoint.takeover_reason || null,
    } : null,
    evidence: evidence ? {
      id: evidence.id,
      acceptance_decision_id: run.acceptance_decision_id,
    } : null,
    intent: intent ? {
      id: intent.id,
      request_text: intent.request_text?.substring(0, 2000),
      operation_kind: intent.operation_kind,
    } : null,
  };
}
