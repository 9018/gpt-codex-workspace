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

/**
 * @deprecated Wave 10R — 旧调度器路径。
 * 新代码应使用 execution-run-bridge.mjs 或直接调用 execution-core/。
 * useExecutionRun 选项控制是否走新路径：
 *   - true (默认，未来版本): 走 ExecutionRun bridge
 *   - false (当前默认): 走旧 orchestrator
 */
export async function dispatchTaskProvider(input = {}, deps = {}) {
  // If useExecutionRun is set, route through ExecutionRun bridge instead of old orchestrator
  if (input.useExecutionRun) {
    const { executeTaskViaExecutionRun } = await import("./execution-run-bridge.mjs");
    if (!input.task?.id) throw new Error("task.id is required");
    const requested = requestedProvider(input.task);
    const provider = requested !== "auto" ? requested : "codex_tui";

    // Build provider registry from the providers passed by caller
    const bridgeRegistry = deps.providerRegistry || createExecutionProviderRegistry();
    // Merge input.providers (from callers like dispatch-bridge test)
    // with deps.providers (from production wiring)
    const inputProviders = input.providers || {};
    const depsProviders = deps.providers || defaultProviders(deps);
    const bridgeProviders = { ...depsProviders, ...inputProviders };
    for (const bp of Object.values(bridgeProviders)) {
      if (bp && !bridgeRegistry.get(bp.name)) bridgeRegistry.register(bp);
    }

    const bridgeCtx = { ...(input.context || {}), workspaceRoot: input.workspaceRoot, task: input.task, goal: input.goal || null, executionCwd: input.executionCwd || input.pathContext?.execution_cwd || null, pathContext: input.pathContext || null, tuiAvailable: input.tuiAvailable, codexTuiEvidenceWaitMs: input.codexTuiEvidenceWaitMs };
    try {
      const bridgeResult = await executeTaskViaExecutionRun({
        taskId: input.task.id,
        goalId: input.goal?.id || null,
        provider,
        context: bridgeCtx,
        deps: {
          providerRegistry: bridgeRegistry,
          acceptanceService: deps.acceptanceService || null,
          projectionService: deps.projectionService || null,
          attemptStore: deps.attemptStore || null,
          taskTransitionService: deps.taskTransitionService || null,
        },
      });
      return {
        attempt: bridgeResult.attempt,
        evidence: bridgeResult.evidence,
        status: bridgeResult.attempt.state,
        provider: bridgeResult.attempt.provider,
        selection: { provider, reason_code: "execution_run_bridge", scores: null },
      };
    } catch (err) {
      return { status: "failed", provider, selection: null, evidence: null, error: err.message };
    }
  }
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
    // Per plan: TUI unavailable does NOT auto-fallback to exec.
    // Instead, create checkpoint for supervisor review.
    if (provider === "codex_tui" && availability.codex_exec) {
      // Still allow fallback if explicitly configured
      if (input.task?.execution_policy?.fallback_allowed === true) {
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
      } // end fallback_allowed
      // When fallback not allowed, just return unavailable
      return {
        status: "waiting_for_supervisor",
        provider: "codex_tui",
        selection: { provider: "codex_tui", reason_code: "tui_unavailable_no_fallback", scores: null },
        failure: { code: "tui_unavailable", message: "TUI unavailable and fallback is not allowed" },
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
