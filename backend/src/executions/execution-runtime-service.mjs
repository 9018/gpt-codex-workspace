/**
 * execution-runtime-service.mjs — Provider-neutral execution orchestration.
 *
 * This is the canonical entry point for starting, monitoring, and collecting
 * task executions.  It coordinates:
 *   - Execution request normalization
 *   - Worktree materialization
 *   - Repository lock management
 *   - Provider dispatch (codex_exec or codex_tui)
 *   - Evidence collection and normalization
 *   - Task status transitions (through taskTransitionService)
 *
 * @module execution-runtime-service
 */

import { normalizeExecutionRequest } from "./execution-contract.mjs";
import { normalizeExecutionEvidence } from "./execution-evidence-normalizer.mjs";

/**
 * Create the execution runtime service.
 *
 * @param {object} options
 * @param {object}   options.store               - StateStore for tasks/goals
 * @param {object}   options.executionStore      - ExecutionStore for execution records
 * @param {object}   options.providerRegistry    - Provider registry (from createProviderRegistry)
 * @param {object}   options.taskTransitionService - Task transition service
 * @param {object}   options.repositoryPlanner   - Repository plan resolver
 * @param {object}   options.worktreeManager     - Worktree materialization
 * @param {object}   options.repoLockManager     - Repo lock acquire/release
 * @param {Function} [options.now]               - Timestamp generator
 * @returns {object} { start, status, stop, collect, cancel }
 */
export function createExecutionRuntimeService({
  store,
  executionStore,
  providerRegistry,
  taskTransitionService,
  repositoryPlanner,
  worktreeManager,
  repoLockManager,
  now,
}) {
  const _now = now || (() => new Date().toISOString());

  /**
   * Start a new execution for a task.
   *
   * @param {object} requestInput - Execution request (see execution-contract.mjs)
   * @returns {Promise<object>} { execution_id, execution, session_info }
   */
  async function start(requestInput) {
    const request = normalizeExecutionRequest(requestInput);

    // Load task and goal
    const state = await store.load();
    const task = (state.tasks || []).find((t) => t.id === request.task_id);
    if (!task) throw new Error(`Task not found: ${request.task_id}`);

    // Claim the task via transition service
    const claimResult = await taskTransitionService.transitionTask({
      task_id: task.id,
      event: "execution_claimed",
      expected_statuses: ["assigned", "queued", "waiting_for_repair"],
      idempotency_key: `${request.request_id}:claim`,
      source: request.provider,
      payload: {},
    });

    // Resolve repository plan
    let plan, materialized, lock;
    if (repositoryPlanner && worktreeManager && repoLockManager) {
      try {
        plan = await repositoryPlanner.resolve({ task, goal: null, request });
        materialized = await worktreeManager.materialize(plan);
        lock = await repoLockManager.acquire(plan);
      } catch (err) {
        // If worktree setup fails, revert task claim
        await taskTransitionService.transitionTask({
          task_id: task.id,
          event: "execution_evidence_failed",
          expected_statuses: ["starting"],
          idempotency_key: `${request.request_id}:worktree_failed`,
          source: request.provider,
          payload: { canonical_status: "failed", repairable: false },
        });
        throw err;
      }
    }

    // Get the provider
    const provider = providerRegistry.get(request.provider);
    if (!provider) {
      throw new Error(`Provider not found: ${request.provider}`);
    }

    // Create execution record
    const execution = await executionStore.createExecution({
      goalId: request.goal_id || task.goal_id,
      taskId: task.id,
      worktreePath: materialized?.worktree_path || null,
      branch: plan?.branch || null,
      baseCommit: plan?.base_commit || null,
      metadata: {
        request_id: request.request_id,
        provider: request.provider,
        interaction_mode: request.interaction_mode,
        ...request.metadata,
      },
    });

    // Update execution with provider info
    await executionStore.updateExecution(execution.id, {
      status: "preparing",
      provider: request.provider,
      interaction_mode: request.interaction_mode,
    });

    // Transition task to starting
    await taskTransitionService.transitionTask({
      task_id: task.id,
      event: "execution_started",
      expected_statuses: ["starting"],
      idempotency_key: `${execution.id}:started`,
      source: request.provider,
      payload: { execution_id: execution.id },
    });

    // Start the provider
    const started = await provider.start({
      execution: { ...execution, id: execution.id },
      request,
      task,
      goal: null,
      cwd: materialized?.worktree_path || process.cwd(),
    });

    // Update execution status
    await executionStore.updateExecution(execution.id, {
      status: "running",
      provider_run_id: started.provider_run_id,
      runtime_details: started.runtime_details || {},
    });

    return {
      execution_id: execution.id,
      execution: await executionStore.readExecution(execution.id),
      session_info: started.runtime_details || null,
    };
  }

  /**
   * Get current status of an execution.
   *
   * @param {object} params
   * @param {string} params.execution_id
   * @returns {Promise<object>} Execution status
   */
  async function status({ execution_id }) {
    const execution = await executionStore.readExecution(execution_id);
    const provider = providerRegistry.get(execution.provider);

    let providerStatus = {};
    if (provider && execution.provider_run_id) {
      try {
        providerStatus = await provider.status({ execution });
      } catch {
        // Provider status failure is non-fatal
      }
    }

    // Load task for task_status
    const state = await store.load();
    const task = (state.tasks || []).find((t) => t.id === execution.task_id);

    return {
      execution_id,
      provider: execution.provider,
      execution_status: execution.status,
      task_id: execution.task_id,
      task_status: task?.status || null,
      started_at: execution.created_at,
      runtime_details: execution.runtime_details,
      provider_status: providerStatus,
    };
  }

  /**
   * Stop a running execution.  Does NOT decide task final status.
   *
   * @param {object} params
   * @param {string} params.execution_id
   * @param {string} [params.reason="stop_requested"]
   * @returns {Promise<object>} Stop result
   */
  async function stop({ execution_id, reason = "stop_requested" }) {
    const execution = await executionStore.readExecution(execution_id);
    const provider = providerRegistry.get(execution.provider);

    // Update execution status
    await executionStore.updateExecution(execution_id, {
      status: "stopping",
      updated_at: _now(),
    });

    // Stop the provider
    let stopResult = {};
    if (provider && execution.provider_run_id) {
      try {
        stopResult = await provider.stop({ execution, reason });
      } catch (err) {
        // Non-fatal
      }
    }

    // Transition task to collecting (not to a terminal state!)
    await taskTransitionService.transitionTask({
      task_id: execution.task_id,
      event: "execution_session_stopped",
      expected_statuses: ["running", "starting"],
      idempotency_key: `${execution_id}:stopped`,
      source: execution.provider || "unknown",
      reason: reason,
      payload: { execution_id },
    });

    return {
      execution_id,
      stopped: true,
      next_action: "call collect to gather durable evidence",
      provider_result: stopResult,
    };
  }

  /**
   * Cancel a running execution.
   *
   * @param {object} params
   * @param {string} params.execution_id
   * @param {string} [params.reason="cancelled"]
   * @returns {Promise<object>} Cancel result
   */
  async function cancel({ execution_id, reason = "cancelled" }) {
    const execution = await executionStore.readExecution(execution_id);
    const provider = providerRegistry.get(execution.provider);

    if (provider && execution.provider_run_id) {
      try {
        await provider.cancel({ execution });
      } catch {
        // Non-fatal
      }
    }

    await executionStore.updateExecution(execution_id, {
      status: "cancelled",
      updated_at: _now(),
    });

    await taskTransitionService.transitionTask({
      task_id: execution.task_id,
      event: "cancel_requested",
      expected_statuses: [],
      idempotency_key: `${execution_id}:cancelled`,
      source: "operator",
      reason: reason,
      payload: { execution_id },
    });

    return { execution_id, cancelled: true };
  }

  /**
   * Collect execution evidence and normalize it.
   *
   * @param {object} params
   * @param {string} params.execution_id
   * @returns {Promise<{execution: object, evidence: object}>}
   */
  async function collect({ execution_id }) {
    const execution = await executionStore.readExecution(execution_id);
    const provider = providerRegistry.get(execution.provider);

    if (!provider) {
      throw new Error(`Provider not found for execution ${execution_id}`);
    }

    // Update execution to collecting
    await executionStore.updateExecution(execution_id, {
      status: "collecting",
      updated_at: _now(),
    });

    // Signal task that collection started
    await taskTransitionService.transitionTask({
      task_id: execution.task_id,
      event: "execution_evidence_collection_started",
      expected_statuses: ["running", "collecting"],
      idempotency_key: `${execution_id}:collect:start`,
      source: execution.provider || "unknown",
      payload: { execution_id },
    });

    // Collect raw evidence from provider
    const raw = await provider.collect({ execution });

    // Normalize into canonical evidence
    const evidence = normalizeExecutionEvidence({
      ...raw,
      execution_id,
      provider: execution.provider,
      task_id: execution.task_id,
    });

    // Attach evidence to execution record
    await executionStore.attachEvidence(execution_id, evidence);

    // Update execution status
    const finalStatus = evidence.diagnostics?.blockers?.length > 0
      ? "failed"
      : "evidence_ready";

    await executionStore.updateExecution(execution_id, {
      status: finalStatus,
      updated_at: _now(),
      runtime_details: {
        ...(execution.runtime_details || {}),
        evidence_blockers: evidence.diagnostics?.blockers?.length || 0,
      },
    });

    return {
      execution: await executionStore.readExecution(execution_id),
      evidence,
    };
  }

  return { start, status, stop, collect, cancel };
}
