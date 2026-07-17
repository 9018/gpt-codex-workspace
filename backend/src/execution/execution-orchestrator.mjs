import { buildExecutionCheckpoint } from "./execution-checkpoint.mjs";
import { normalizeExecutionEvidence } from "./execution-evidence.mjs";
import { classifyExecutionProviderFailure, executionFailureState } from "./execution-failure-classifier.mjs";
import { selectFailoverProvider } from "./provider-failover-policy.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createExecutionOrchestrator({
  attemptStore,
  providerRegistry,
  repositorySnapshot = async () => ({ head: null, dirty_paths: [] }),
  acceptanceSnapshot = async () => ({ completed_items: [] }),
  sleepFn = sleep,
  observeIntervalMs = 1_000,
  maxObserveCycles = 7_200,
} = {}) {
  if (!attemptStore || !providerRegistry) throw new Error("attemptStore and providerRegistry are required");

  async function claim(input) {
    const provider = providerRegistry.get(input.provider);
    if (!provider) throw new Error(`execution provider unavailable: ${input.provider}`);
    const result = await attemptStore.claim({
      taskId: input.taskId,
      goalId: input.goalId,
      provider: input.provider,
      providerRevision: provider.revision || null,
      pathContext: input.pathContext,
      inputSnapshot: input.inputSnapshot,
      checkpoint: input.checkpoint || null,
    });
    if (!result.claimed) throw new Error(`active execution attempt exists: ${result.active_attempt.id}`);
    return { attempt: result.attempt, provider };
  }

  async function run(input) {
    let current = await claim(input);
    let handle = null;
    let checkpoint = input.checkpoint || null;
    let shouldResume = Boolean(checkpoint);
    let observeCycles = 0;

    async function failCurrent(failure, expectedState) {
      const state = executionFailureState(failure);
      if (handle && ["timed_out", "provider_unavailable"].includes(state) && typeof current.provider.interrupt === "function") {
        await current.provider.interrupt(handle, {
          ...(input.context || {}),
          interruptReason: state === "timed_out" ? "evidence_timeout" : "provider_unavailable",
        }).catch(() => {});
      }
      current.attempt = await attemptStore.transition(current.attempt.id, {
        expectedState,
        state,
        failure,
      });
      if (handle && typeof current.provider.dispose === "function") {
        await current.provider.dispose(handle, input.context || {}).catch(() => {});
      }
      const availability = await providerRegistry.availability(input.context || {});
      const failover = selectFailoverProvider({ attempt: current.attempt, failure, availability });
      if (!failover) return false;

      checkpoint = buildExecutionCheckpoint({
        attempt: current.attempt,
        repository: await repositorySnapshot(current.attempt),
        acceptance: await acceptanceSnapshot(current.attempt),
        failure,
        nativeSessionId: failure.native_session_id || null,
        controlSessionId: handle?.session_id || handle?.id || null,
      });
      current = await claim({ ...input, provider: failover.provider, checkpoint });
      handle = null;
      shouldResume = true;
      observeCycles = 0;
      return true;
    }

    while (true) {
      if (!handle) {
        try {
          handle = shouldResume
            ? await current.provider.resume(current.attempt, checkpoint, input.context || {})
            : await current.provider.start(current.attempt, input.context || {});
          current.attempt = await attemptStore.transition(current.attempt.id, {
            expectedState: "starting",
            state: "running",
            providerHandle: handle,
            ...(checkpoint ? { checkpoint } : {}),
          });
        } catch (error) {
          const failure = classifyExecutionProviderFailure(error, {
            provider: current.attempt.provider,
            phase: shouldResume ? "resume" : "start",
          });
          if (await failCurrent(failure, "starting")) continue;
          return { attempt: current.attempt, evidence: null };
        }
      }

      let observed;
      try {
        observed = await current.provider.observe(handle, input.context || {});
      } catch (error) {
        const failure = classifyExecutionProviderFailure(error, {
          provider: current.attempt.provider,
          phase: "observe",
        });
        if (await failCurrent(failure, "running")) continue;
        return { attempt: current.attempt, evidence: null };
      }
      if (observed?.state === "evidence_ready" || observed?.state === "completed") {
        current.attempt = await attemptStore.transition(current.attempt.id, {
          expectedState: "running",
          state: "evidence_ready",
        });
        const rawEvidence = await current.provider.collect(handle, input.context || {});
        const evidence = normalizeExecutionEvidence(rawEvidence, {
          provider: current.attempt.provider,
          attemptId: current.attempt.id,
        });
        current.attempt = await attemptStore.transition(current.attempt.id, {
          expectedState: "evidence_ready",
          state: evidence.status,
          evidence,
        });
        await current.provider.dispose(handle, input.context || {});
        return { attempt: current.attempt, evidence };
      }

      if (["failed", "timed_out", "provider_unavailable"].includes(observed?.state)) {
        const failure = {
          ...(observed.failure || { code: observed.state }),
          native_session_id: observed.native_session_id || null,
        };
        if (await failCurrent(failure, "running")) continue;
        return { attempt: current.attempt, evidence: null };
      }

      if (observed?.state === "waiting_for_supervisor") {
        checkpoint = {
          ...buildExecutionCheckpoint({
            attempt: current.attempt,
            repository: await repositorySnapshot(current.attempt),
            acceptance: await acceptanceSnapshot(current.attempt),
            nativeSessionId: observed.native_session_id || handle?.native_session_id || null,
            controlSessionId: handle?.session_id || handle?.id || null,
          }),
          ...(observed.checkpoint && typeof observed.checkpoint === "object"
            ? structuredClone(observed.checkpoint)
            : {}),
        };
        current.attempt = await attemptStore.transition(current.attempt.id, {
          expectedState: "running",
          state: "waiting_for_supervisor",
          checkpoint,
        });
        return { attempt: current.attempt, evidence: null, checkpoint };
      }

      if (observed?.state === "running" || observed?.state === "starting") {
        observeCycles += 1;
        if (observeCycles >= maxObserveCycles) {
          const failure = {
            code: "provider_timeout",
            failure_class: "execution_timeout",
            provider: current.attempt.provider,
            phase: "observe",
            native_session_id: observed.native_session_id || null,
          };
          if (await failCurrent(failure, "running")) continue;
          return { attempt: current.attempt, evidence: null };
        }
        if (observeIntervalMs > 0) await sleepFn(observeIntervalMs);
        continue;
      }

      const failure = {
        code: "invalid_provider_observation",
        failure_class: "execution_failed",
        provider: current.attempt.provider,
        phase: "observe",
        observation: observed || null,
      };
      if (await failCurrent(failure, "running")) continue;
      return { attempt: current.attempt, evidence: null };
    }
  }

  return { run };
}
