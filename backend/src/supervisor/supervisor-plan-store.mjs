/**
 * supervisor-plan-store.mjs — SupervisorPlan store with optional persistence.
 *
 * @module supervisor-plan-store
 */

import { createSupervisorPlan } from "./supervisor-plan-schema.mjs";
import { SupervisorPlanNotFoundError } from "./supervisor-errors.mjs";

/**
 * Create a SupervisorPlan store.
 *
 * @param {object} [options]
 * @param {object} [options.stateStore] - Optional durable state store
 * @returns {object} Store API
 */
export function createSupervisorPlanStore({ stateStore } = {}) {
  /** @type {Map<string, object>} */
  const _plans = new Map();
  /** Index: run_id -> plan_id */
  const _runIndex = new Map();

  async function _loadPersisted() {
    if (!stateStore) return;
    const state = await stateStore.load();
    if (state.supervisor_plans) {
      for (const [id, plan] of Object.entries(state.supervisor_plans)) {
        _plans.set(id, plan);
        _runIndex.set(plan.run_id, id);
      }
    }
  }

  async function _persist() {
    if (!stateStore) return;
    await stateStore.mutate((state) => {
      state.supervisor_plans = Object.fromEntries(_plans);
    });
  }

  _loadPersisted().catch(() => {});

  /**
   * Create a new SupervisorPlan.
   *
   * @param {object} input - Fields for createSupervisorPlan
   * @returns {Promise<object>}
   */
  async function createPlan(input) {
    const plan = createSupervisorPlan(input);
    _plans.set(plan.id, structuredClone(plan));
    _runIndex.set(plan.run_id, plan.id);
    await _persist();
    return structuredClone(plan);
  }

  /**
   * Read a plan by ID.
   * @param {string} planId
   * @returns {Promise<object>}
   */
  async function readPlan(planId) {
    const plan = _plans.get(planId);
    if (!plan) throw new SupervisorPlanNotFoundError(planId);
    return structuredClone(plan);
  }

  /**
   * Find the active plan for a run.
   * @param {string} runId
   * @returns {Promise<object|null>}
   */
  async function findPlanByRunId(runId) {
    const planId = _runIndex.get(runId);
    if (!planId) return null;
    return readPlan(planId);
  }

  /**
   * Count all plans.
   * @returns {number}
   */
  function count() {
    return _plans.size;
  }

  return { createPlan, readPlan, findPlanByRunId, count };
}
