function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function createFaultInjectionHarness() {
  const timeline = [];
  const completedEffects = new Map();
  const faults = new Map();

  return {
    inject(point, error, { times = 1 } = {}) {
      faults.set(point, { error, remaining: Math.max(1, Number(times) || 1) });
    },

    checkpoint(point, detail = null) {
      timeline.push({ type: "checkpoint", point, detail: clone(detail) });
      const fault = faults.get(point);
      if (!fault || fault.remaining <= 0) return;
      fault.remaining -= 1;
      throw fault.error instanceof Error ? fault.error : new Error(String(fault.error));
    },

    async effectOnce(key, effect) {
      if (completedEffects.has(key)) return clone(completedEffects.get(key));
      const result = await effect();
      completedEffects.set(key, clone(result));
      timeline.push({ type: "effect", key, result: clone(result) });
      return clone(result);
    },

    recordEffect(key, result = null) {
      if (completedEffects.has(key)) return false;
      completedEffects.set(key, clone(result));
      timeline.push({ type: "effect", key, result: clone(result) });
      return true;
    },

    effects() {
      return timeline.filter((entry) => entry.type === "effect").map((entry) => entry.key);
    },

    trace() {
      return clone(timeline);
    },
  };
}

export function createMemoryStateStore(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async load() { return state; },
    async mutate(updater) { return updater(state); },
  };
}

export function createMemoryAttemptStore() {
  const attempts = [];
  return {
    attempts,
    async claim(input) {
      const active = attempts.find((attempt) => (
        attempt.task_id === input.taskId
        && ["starting", "running", "evidence_ready", "waiting_for_supervisor"].includes(attempt.state)
      ));
      if (active) return { claimed: false, active_attempt: active };
      const attempt = {
        id: `attempt_${attempts.length + 1}`,
        task_id: input.taskId,
        goal_id: input.goalId || null,
        provider: input.provider,
        provider_revision: input.providerRevision || null,
        state: "starting",
        attempt_number: attempts.filter((entry) => entry.task_id === input.taskId).length + 1,
        path_context: clone(input.pathContext),
        input_snapshot: clone(input.inputSnapshot),
        checkpoint: clone(input.checkpoint),
      };
      attempts.push(attempt);
      return { claimed: true, attempt };
    },
    async transition(id, patch) {
      const attempt = attempts.find((entry) => entry.id === id);
      if (!attempt) throw new Error(`attempt not found: ${id}`);
      if (patch.expectedState && attempt.state !== patch.expectedState) {
        throw new Error(`attempt state mismatch: expected ${patch.expectedState}, got ${attempt.state}`);
      }
      attempt.state = patch.state;
      if (patch.providerHandle !== undefined) attempt.provider_handle = clone(patch.providerHandle);
      if (patch.checkpoint !== undefined) attempt.checkpoint = clone(patch.checkpoint);
      if (patch.evidence !== undefined) attempt.evidence = clone(patch.evidence);
      if (patch.failure !== undefined) attempt.failure = clone(patch.failure);
      return attempt;
    },
  };
}
