/**
 * full-executor.mjs — Unified execution coordinator for full mode.
 *
 * Responsibilities:
 *   1. Read normalized contract
 *   2. Create worktree + acquire lock
 *   3. Start provider (codex_tui or local_patch)
 *   4. Sync heartbeat/progress
 *   5. On failure: classify + retry via reconcileTaskRuntime
 *   6. On completion: collect evidence → machine acceptance → integrate
 *
 * Both ChatGPT (actor="chatgpt") and Codex (actor="codex") use the same executor.
 */

import { buildAcceptanceContract } from "../acceptance/contract-builder.mjs";
import { ACCEPTANCE_CONTRACT_SCHEMA_VERSION } from "../acceptance/contract-schema.mjs";
import { createFullExecutionProvider } from "./full-execution-provider.mjs";
import { reconcileTaskRuntime } from "../runtime/task-runtime-reconciler.mjs";

/**
 * Execute a task in full mode.
 *
 * @param {object} options
 * @param {object}   options.store          - State store
 * @param {object}   options.config         - Config
 * @param {string}   options.taskId         - Task ID
 * @param {string}   [options.actor]        - "codex" or "chatgpt"
 * @param {string}   [options.providerName] - "codex_tui" or "local_patch"
 * @param {object}   [options.providerDeps] - Provider dependencies
 * @returns {Promise<{ task_id, session_id, ok }>}
 */
export async function executeFullTask(options = {}) {
  const {
    store,
    config = {},
    taskId,
    actor = "codex",
    providerName = "codex_tui",
    providerDeps = {},
  } = options;

  if (!store) throw new Error("store is required");
  if (!taskId) throw new Error("taskId is required");

  const state = await store.load();
  const task = Array.isArray(state.tasks) ? state.tasks.find((t) => t.id === taskId) : null;
  if (!task) throw new Error(`task not found: ${taskId}`);

  const goal = Array.isArray(state.goals) ? state.goals.find((g) => g.id === task.goal_id) : null;

  // --- Step 1: Build / normalize the acceptance contract ---
  const contract = buildAcceptanceContract({
    acceptance_contract: task.acceptance_contract || goal?.acceptance_contract,
    text: task.description || goal?.goal_prompt || "",
    mode: task.mode,
  });

  if (contract.mode !== "full") {
    throw new Error(`Contract mode must be "full", got "${contract.mode}"`);
  }

  // --- Step 2: Transition state to "starting" ---
  const sessionId = `full_${taskId}_${Date.now()}`;

  await reconcileTaskRuntime({ store, config, taskId, trigger: "full_executor_start" });

  // --- Step 3: Start the provider ---
  const provider = createFullExecutionProvider(providerName, providerDeps);

  let session;
  try {
    session = await provider.start({
      task,
      goal,
      cwd: config.defaultWorkspaceRoot || process.cwd(),
      workspaceRoot: config.defaultWorkspaceRoot,
    });
  } catch (err) {
    // Provider start failed — reconciler will handle retry
    await reconcileTaskRuntime({ store, config, taskId, trigger: "provider_start_failed" });
    throw err;
  }

  // --- Step 4: Return immediately — reconciler monitors progress ---
  return {
    task_id: taskId,
    session_id: session?.id || sessionId,
    provider: providerName,
    actor,
    contract_version: ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    ok: true,
  };
}
