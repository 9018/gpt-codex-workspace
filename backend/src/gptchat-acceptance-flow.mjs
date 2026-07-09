/**
 * gptchat-acceptance-flow.mjs — Orchestrates the GPTChat acceptance loop.
 *
 * Full flow:
 * 1. Load task / goal / acceptance bundle
 * 2. Build acceptance bundle zip
 * 3. Create GPTChat coordination request with acceptance prompt
 * 4. (GPTChat reviews the bundle)
 * 5. Ingest the acceptance response
 * 6. If rejected: create repair goal with full context
 * 7. Record acceptance result in task/goal state
 *
 * This replaces manual ad-hoc acceptance with an automated flow that
 * can be triggered by:
 *   - `scripts/acceptance-workflow.sh --task-id <task_id>`
 *   - MCP tool `submit_for_gptchat_acceptance`
 *   - Automatic trigger after Codex task completion (when configured)
 */

import { buildAcceptancePrompt } from './gptchat-acceptance/prompt-templates.mjs';
import { buildAcceptanceBundleFromTask } from './gptchat-acceptance/bundle-builder.mjs';
import { ingestAcceptanceResponse } from './gptchat-acceptance/response-ingestor.mjs';
import { getTaskAcceptanceBundle } from './review/task-acceptance-bundle.mjs';

/**
 * Submit a task for GPTChat acceptance review.
 *
 * Step 1: Build acceptance bundle (zip + prompt)
 * Step 2: Create a ChatGPT coordination request with the bundle reference
 * Step 3: Return the request so caller can await GPTChat response
 *
 * @param {object} options
 * @param {object} options.store - State store
 * @param {object} options.config - Server config
 * @param {string} options.taskId - Task ID to submit for acceptance
 * @param {string} [options.acceptanceCriteria] - Optional custom acceptance criteria
 * @param {object} [options.contract] - Optional explicit acceptance contract
 * @returns {Promise<{ submitted: boolean, bundlePath: string, bundleSha256: string, requestId: string, taskId: string, goalId: string, warnings: string[] }>}
 */
export async function submitForGptchatAcceptance({
  store,
  config = {},
  taskId,
  acceptanceCriteria,
  contract,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!taskId) throw new Error('taskId is required');

  const warnings = [];

  // Resolve task and goal
  const state = await store.load();
  const task = state.tasks?.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const goal = (task.goal_id && state.goals?.find((g) => g.id === task.goal_id)) || null;

  // 1. Build acceptance bundle (compact structure)
  let bundle;
  try {
    bundle = await getTaskAcceptanceBundle({ store, config, task_id: taskId });
  } catch (err) {
    warnings.push(`Could not build acceptance bundle data: ${err.message}. Continuing with limited context.`);
  }

  // 2. Build acceptance bundle zip
  let bundleZipPath;
  let bundleSha256;
  try {
    const zipResult = await buildAcceptanceBundleFromTask({
      bundle,
      store,
      config,
    });
    bundleZipPath = zipResult.bundlePath;
    bundleSha256 = zipResult.bundleSha256;
  } catch (err) {
    warnings.push(`Could not create acceptance bundle zip: ${err.message}. Proceeding without zip.`);
  }

  // 3. Build the acceptance prompt
  const acceptancePrompt = buildAcceptancePrompt({
    bundle,
    acceptanceCriteria,
    contract,
    bundleRef: bundleZipPath || null,
  });

  // 4. Create the ChatGPT coordination request
  const { createChatGptRequest } = await import('./tool-groups/chatgpt-request-tools-group.mjs');
  const request = await createChatGptRequest(store, {
    title: `Acceptance Review: ${task.title || taskId}`,
    prompt: acceptancePrompt,
    source: 'gptchat_acceptance_flow',
    task_id: taskId,
    workspace_id: task.workspace_id || goal?.workspace_id || 'hosted-default',
    escalation_category: 'acceptance_review',
    why_subagents_cannot_decide: 'Acceptance requires human judgment to verify task results and determine if acceptance criteria are satisfied.',
    options_considered: JSON.stringify(['auto_accept', 'skip_acceptance', 'gptchat_review']),
    default_if_no_response: 'waiting_for_review',
  });

  return {
    submitted: true,
    bundlePath: bundleZipPath,
    bundleSha256,
    requestId: request.request?.id || null,
    taskId,
    goalId: goal?.id || task.goal_id || null,
    warnings,
  };
}

/**
 * Ingest a GPTChat response to an acceptance review request.
 *
 * @param {object} options
 * @param {object} options.store - State store
 * @param {object} options.config - Server config
 * @param {string} options.requestId - The ChatGPT coordination request ID
 * @param {string} options.taskId - The task ID being reviewed
 * @param {string} options.responseText - GPTChat's response
 * @returns {Promise<object>}
 */
export async function acceptGptchatResponseForTask({
  store,
  config = {},
  requestId,
  taskId,
  responseText,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!requestId) throw new Error('requestId is required');
  if (!taskId) throw new Error('taskId is required');

  const warnings = [];

  // Resolve task and goal
  const state = await store.load();
  const task = state.tasks?.find((t) => t.id === taskId);
  const goal = (task?.goal_id && state.goals?.find((g) => g.id === task.goal_id)) || null;

  // Build acceptance bundle for context
  let bundle;
  try {
    bundle = await getTaskAcceptanceBundle({ store, config, task_id: taskId });
  } catch {
    // non-fatal
  }

  // Ingest the response
  const ingestionResult = await ingestAcceptanceResponse({
    store,
    config,
    taskId,
    responseText,
    bundle,
    goal,
    task,
  });

  warnings.push(...ingestionResult.warnings);

  return {
    ...ingestionResult,
    taskId,
    goalId: goal?.id || task?.goal_id || null,
    requestId,
    warnings,
  };
}

/**
 * End-to-end: submit for GPTChat acceptance, then ingest the response.
 *
 * @param {object} options
 * @param {object} options.store
 * @param {object} options.config
 * @param {string} options.taskId
 * @param {string} options.gptchatResponseText - GPTChat's response to ingest immediately
 * @param {string} [options.acceptanceCriteria]
 * @returns {Promise<object>}
 */
export async function runAcceptanceFlow({ store, config, taskId, gptchatResponseText, acceptanceCriteria } = {}) {
  // 1. Submit (build bundle + create request)
  const submission = await submitForGptchatAcceptance({
    store,
    config,
    taskId,
    acceptanceCriteria,
  });

  // 2. Ingest the response (if provided)
  if (gptchatResponseText && submission.requestId) {
    const ingestion = await acceptGptchatResponseForTask({
      store,
      config,
      requestId: submission.requestId,
      taskId,
      responseText: gptchatResponseText,
    });
    return { ...submission, ingestion };
  }

  return { ...submission, ingestion: null };
}
