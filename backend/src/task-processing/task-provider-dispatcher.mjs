import { createExecutionAttemptStore } from "../execution/execution-attempt-store.mjs";
import { createExecutionOrchestrator } from "../execution/execution-orchestrator.mjs";
import { createExecutionProviderRegistry } from "../execution/execution-provider-registry.mjs";
import { buildExecutionCheckpoint } from "../execution/execution-checkpoint.mjs";
import { selectExecutionProvider } from "../execution/provider-selection-policy.mjs";
import { createCodexExecProvider } from "../execution/providers/codex-exec-provider.mjs";
import { createCodexTuiProvider } from "../execution/providers/codex-tui-provider.mjs";

function requestedProvider(task = {}) {
  const raw = task.execution_policy?.provider
    || task.metadata?.execution_provider
    || task.metadata?.codex_execution_provider
    || "auto";
  if (raw === "codex_tui_goal" || raw === "codex_tui") return "codex_tui";
  if (raw === "auto") return "auto";
  return "codex_exec";
}

function defaultProviders(deps = {}) {
  return {
    codex_exec: createCodexExecProvider({
      executeCodexTaskRunFn: deps.executeCodexTaskRunFn,
    }),
    codex_tui: createCodexTuiProvider({
      startCodexTuiGoalSessionFn: deps.startCodexTuiGoalSessionFn,
      getCodexTuiSessionStatusFn: deps.getCodexTuiSessionStatusFn,
      sendCodexTuiSessionInputFn: deps.sendCodexTuiSessionInputFn,
      stopCodexTuiSessionFn: deps.stopCodexTuiSessionFn,
      collectCodexTuiCompletionFn: deps.collectCodexTuiCompletionFn,
      runCodexTuiEvidenceCycleFn: deps.runCodexTuiEvidenceCycleFn,
      availableFn: deps.tuiAvailableFn,
    }),
  };
}

async function persistUnavailableAttempt({ attemptStore, input, provider, reason }) {
  const claim = await attemptStore.claim({
    taskId: input.task.id,
    goalId: input.goal?.id || null,
    provider,
    pathContext: input.pathContext || null,
    inputSnapshot: input.inputSnapshot || null,
  });
  if (!claim.claimed) {
    return { attempt: claim.active_attempt, failure: { code: "active_execution_attempt", message: reason } };
  }
  const failure = {
    code: "provider_unavailable",
    failure_class: "provider_interruption",
    provider,
    phase: "selection",
    message: reason,
  };
  const attempt = await attemptStore.transition(claim.attempt.id, {
    expectedState: "starting",
    state: "provider_unavailable",
    failure,
  });
  return { attempt, failure };
}

export async function dispatchTaskProvider(input = {}, deps = {}) {
  if (!input.workspaceRoot) throw new Error("workspaceRoot is required");
  if (!input.task?.id) throw new Error("task.id is required");

  const registry = deps.providerRegistry || createExecutionProviderRegistry();
  const providers = deps.providers || defaultProviders(deps);
  for (const provider of Object.values(providers)) {
    if (provider && !registry.get(provider.name)) registry.register(provider);
  }

  const attemptStore = deps.attemptStore || createExecutionAttemptStore({
    workspaceRoot: input.workspaceRoot,
    now: deps.now,
  });
  const context = {
    ...(input.context || {}),
    workspaceRoot: input.workspaceRoot,
    task: input.task,
    goal: input.goal || null,
    executionCwd: input.executionCwd || input.pathContext?.execution_cwd || null,
    pathContext: input.pathContext || null,
    tuiAvailable: input.tuiAvailable,
    codexTuiEvidenceWaitMs: input.codexTuiEvidenceWaitMs,
  };
  const availability = await registry.availability(context);
  const requested = requestedProvider(input.task);
  let selection;
  try {
    selection = await selectExecutionProvider({
      policy: { provider: requested },
      task: input.task,
      availability,
      history: input.providerHistory || {},
    });
  } catch (error) {
    const provider = requested === "auto" ? "codex_exec" : requested;
    const unavailable = await persistUnavailableAttempt({
      attemptStore,
      input,
      provider,
      reason: error.message,
    });
    if (provider === "codex_tui" && availability.codex_exec) {
      const checkpoint = buildExecutionCheckpoint({
        attempt: unavailable.attempt,
        repository: await (deps.repositorySnapshot?.(unavailable.attempt) || { head: null, dirty_paths: [] }),
        acceptance: await (deps.acceptanceSnapshot?.(unavailable.attempt) || { completed_items: [] }),
        failure: unavailable.failure,
      });
      const orchestrator = deps.orchestrator || createExecutionOrchestrator({
        attemptStore,
        providerRegistry: registry,
        repositorySnapshot: deps.repositorySnapshot,
        acceptanceSnapshot: deps.acceptanceSnapshot,
        sleepFn: deps.sleepFn,
        observeIntervalMs: deps.observeIntervalMs,
        maxObserveCycles: deps.maxObserveCycles,
      });
      const result = await orchestrator.run({
        taskId: input.task.id,
        goalId: input.goal?.id || null,
        provider: "codex_exec",
        pathContext: input.pathContext || null,
        inputSnapshot: input.inputSnapshot || null,
        checkpoint,
        context,
      });
      return {
        ...result,
        status: result.attempt.state,
        provider: result.attempt.provider,
        selection: { provider: "codex_exec", reason_code: "tui_provider_unavailable", scores: null },
      };
    }
    return {
      status: "provider_unavailable",
      provider,
      selection: null,
      evidence: null,
      ...unavailable,
    };
  }

  const orchestrator = deps.orchestrator || createExecutionOrchestrator({
    attemptStore,
    providerRegistry: registry,
    repositorySnapshot: deps.repositorySnapshot,
    acceptanceSnapshot: deps.acceptanceSnapshot,
    sleepFn: deps.sleepFn,
    observeIntervalMs: deps.observeIntervalMs,
    maxObserveCycles: deps.maxObserveCycles,
  });
  const result = await orchestrator.run({
    taskId: input.task.id,
    goalId: input.goal?.id || null,
    provider: selection.provider,
    pathContext: input.pathContext || null,
    inputSnapshot: input.inputSnapshot || null,
    checkpoint: input.checkpoint || null,
    context,
  });

  return {
    ...result,
    status: result.attempt.state,
    provider: result.attempt.provider,
    selection,
  };
}
