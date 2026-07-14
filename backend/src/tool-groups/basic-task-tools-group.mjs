import { basename } from 'node:path';
import { findTask, updateTask } from '../task-lifecycle.mjs';
import { getTaskAcceptanceBundle } from '../review/task-acceptance-bundle.mjs';
import { getTaskReviewPacket } from '../review/review-packet-builder.mjs';
import { normalizeLegacyTaskWorkstream } from '../workstream/workstream-model.mjs';
import { isResolvedLegacyReviewTask, legacyResolutionSummary } from '../legacy-reconciliation.mjs';
import { isHumanReviewStatus, isRepairStatus, isFailedTerminalStatus } from '../task-status-taxonomy.mjs';

/**
 * Build a task summary object suitable for ChatGPT reasoning.
 * Keeps the payload bounded and does not include full result objects.
 */
function buildTaskSummary(task) {
  const result = task.result || {};
  const resolution = legacyResolutionSummary(task);
  const changedFiles = Array.isArray(result.changed_files) ? result.changed_files : [];
  const blockerCodes = [];
  if (isFailedTerminalStatus(task.status)) blockerCodes.push('failed');
  if (isRepairStatus(task.status)) blockerCodes.push('needs_repair');
  if (task.status === 'blocked') blockerCodes.push('blocked');
  if (task.status === 'waiting_for_lock') blockerCodes.push('waiting_for_lock');
  if (task.status === 'waiting_for_integration') blockerCodes.push('integration');
  if (isHumanReviewStatus(task.status)) blockerCodes.push('review');

  // Derive recommended next action from status
  let nextAction = '';
  if (task.status === 'assigned' || task.status === 'queued') nextAction = 'monitor';
  else if (task.status === 'running') nextAction = 'wait';
  else if (isRepairStatus(task.status)) nextAction = 'review_repair';
  else if (isHumanReviewStatus(task.status)) {
    nextAction = isResolvedLegacyReviewTask(task) ? 'resolved_history' : 'review';
  }
  else if (task.status === 'waiting_for_integration') nextAction = 'check_integration';
  else if (task.status === 'waiting_for_lock') nextAction = 'check_lock';
  else if (task.status === 'completed') nextAction = 'complete';
  else if (isFailedTerminalStatus(task.status)) nextAction = 'diagnose';

  return {
    id: task.id,
    title: task.title || '',
    status: task.status || 'unknown',
    assignee: task.assignee || null,
    goal_id: task.goal_id || null,
    mode: task.mode || null,
    created_at: task.created_at || null,
    updated_at: task.updated_at || null,
    result_summary: result.summary || null,
    blocker_codes: blockerCodes.length > 0 ? blockerCodes : null,
    next_action: nextAction || null,
    commit: result.commit || null,
    changed_file_count: changedFiles.length,
    resolved_by: resolution.resolved_by_task_id || null,
    superseded_by: resolution.superseded_by_task_id || null,
  };
}

/**
 * Factory for basic task MCP tool registration.
 * Dependencies (createTask, github) are passed in to avoid circular imports
 * from gptwork-server.mjs.
 */
export function createBasicTaskToolsGroup({ tool, schema, config, store, createTask, github, eventLogger, hookBus }) {
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["task"], outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html" };
  return {
    create_task: tool({
      name: "create_task",
      description: "Create a new project task. ChatGPT uses this to tell Codex what to do. Assign it to Codex and Codex will execute it. Tasks sync to GitHub Issues if configured. For listing Codex session files, use list_codex_sessions_metadata or create_codex_session_inventory_task instead of a free-text task.",
      inputSchema: schema({
      title: { type: "string", description: "Task title summarizing the work to be done." },
      description: { type: "string", description: "Detailed task description or instructions." },
      assignee: { type: "string", description: "Who to assign the task to (e.g. codex, chatgpt).", default: "codex" },
      workspace_id: { type: "string", description: "Workspace ID for scoping." },
      notify: { type: "boolean", description: "Set false to suppress ordinary task Bark notifications for this task." },
      silent: { type: "boolean", description: "Set true to suppress ordinary task Bark notifications for this task." },
      suppress_notifications: { type: "boolean", description: "Set true to suppress ordinary task Bark notifications for this task." },
      notification_policy: { type: "string", description: "Task notification policy. Use 'silent' to suppress ordinary task Bark notifications." },
      metadata: { type: "object", description: "Optional structured task metadata, including notification policy flags." },
      workstream_id: { type: "string", description: "Optional Workstream identity for this Task." },
      root_goal_id: { type: "string", description: "Optional root Goal identity for this Task." },
      parent_goal_id: { type: "string", description: "Optional parent Goal identity for this Task." },
      phase: { type: "string", description: "Optional Workstream phase." },
      iteration: { type: "integer", description: "Optional non-negative Workstream iteration." },
      shard_key: { type: "string", description: "Optional Workstream shard key." },
      workflow_id: { type: "string", description: "Optional workflow identity." }
    }, ["title"]),
      ...common,
      handler: async (args, context) => {
        const result = await createTask(store, config, args, context);
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.created", { task_id: result.task.id, title: result.task.title, assignee: result.task.assignee });
        await hookBus?.emit("onTaskCreated", { task: result.task });
        return result;
      },
    }),
    list_tasks: tool({
      name: "list_tasks",
      description: "List project tasks, optionally filtered. Default response is compact task summaries suitable for ChatGPT reasoning. Use detail=full for complete task objects. Use detail=review for review-focused fields. Does not perform workflow advancement or lock acquisition.",
      inputSchema: schema({
        status: { type: "string", description: "Filter by task status." },
        assignee: { type: "string", description: "Filter by task assignee." },
        limit: { type: "integer", description: "Maximum number of tasks to return. Default: 50." },
        detail: { type: "string", description: "Output detail level. 'summary' (default) returns compact bounded summaries. 'review' returns focused review data. 'full' returns complete task objects." }
      }),
      ...common,
      handler: async ({ status, assignee, limit = 50, detail = 'summary' }) => {
        const state = await store.load();
        let tasks = state.tasks;
        if (status) tasks = tasks.filter((task) => task.status === status);
        if (assignee) tasks = tasks.filter((task) => task.assignee === assignee);
        const goalsById = new Map((state.goals || []).map((goal) => [goal.id, goal]));
        const selectedTasks = tasks.slice(-limit).reverse();
        const totalReturned = selectedTasks.length;
        const truncated = tasks.length > limit;

        // Counts for actionable review and resolved legacy review tasks
        const actionableReviews = selectedTasks.filter(
          (task) => isHumanReviewStatus(task.status) && !isResolvedLegacyReviewTask(task)
        ).length;
        const resolvedLegacyReviews = selectedTasks.filter(
          (task) => isResolvedLegacyReviewTask(task)
        ).length;

        if (detail === 'full') {
          return {
            tasks: selectedTasks.map((task) => normalizeLegacyTaskWorkstream(task, goalsById.get(task.goal_id))),
            _counts: {
              returned: totalReturned,
              truncated,
              actionable_review: actionableReviews,
              resolved_legacy_review: resolvedLegacyReviews,
            },
          };
        }

        if (detail === 'review') {
          const result = await Promise.all(selectedTasks.map(async (task) => {
            const summary = buildTaskSummary(task);
            const packet = await getTaskReviewPacket({ store, config, task_id: task.id }).catch(() => null);
            return {
              ...summary,
              review_packet: packet?.review_packet || null,
            };
          }));
          return { tasks: result, _counts: { returned: totalReturned, truncated, actionable_review: actionableReviews, resolved_legacy_review: resolvedLegacyReviews } };
        }

        // Default: summary
        const summaries = selectedTasks.map(buildTaskSummary);
        return {
          tasks: summaries,
          _counts: {
            returned: totalReturned,
            truncated,
            actionable_review: actionableReviews,
            resolved_legacy_review: resolvedLegacyReviews,
          },
        };
      },
    }),
    get_task: tool({
      name: "get_task",
      description: "Return a full task record with all details. For compact summaries, use list_tasks with the default detail=summary.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => {
        const task = await findTask(store, task_id);
        const state = await store.load();
        const goal = task.goal_id
          ? (typeof store.findGoalById === "function"
              ? await store.findGoalById(task.goal_id)
              : state.goals.find((item) => item.id === task.goal_id))
          : null;
        return { task: normalizeLegacyTaskWorkstream(task, goal) };
      },
    }),
    get_task_acceptance_bundle: tool({
      name: "get_task_acceptance_bundle",
      description: "Return compact task acceptance evidence for review or closure without full goal context, transcripts, memories, or large diffs.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => ({ acceptance_bundle: await getTaskAcceptanceBundle({ store, config, task_id }) }),
    }),
    get_task_review_packet: tool({
      name: "get_task_review_packet",
      description: "Return a minimal task review packet with result, verification, blockers, changed files, and recommended next action.",
      inputSchema: schema({ task_id: "string" }, ["task_id"]),
      ...common,
      handler: async ({ task_id }) => ({ review_packet: await getTaskReviewPacket({ store, config, task_id }) }),
    }),
    update_task_status: tool({
      name: "update_task_status",
      description: "Update a task status. Syncs to GitHub if configured.",
      inputSchema: schema({ task_id: "string", status: "string" }, ["task_id", "status"]),
      ...common,
      handler: async ({ task_id, status }) => {
        const result = await updateTask(store, task_id, (task) => { task.status = status; });
        github.syncTask(result.task).catch(() => {});
        await eventLogger?.append("task.status_changed", { task_id, status });
        await hookBus?.emit("onTaskStatusChanged", { task: result.task });
        return result;
      },
    }),
    append_task_log: tool({
      name: "append_task_log",
      description: "Append a task log entry.",
      inputSchema: schema({ task_id: "string", message: "string" }, ["task_id", "message"]),
      ...common,
      handler: async ({ task_id, message }) => updateTask(store, task_id, (task) => { task.logs.push({ time: new Date().toISOString(), message }); }),
    }),
    attach_task_artifact: tool({
      name: "attach_task_artifact",
      description: "Attach a task artifact reference.",
      inputSchema: schema({ task_id: "string", path: "string", label: "string" }, ["task_id", "path"]),
      ...common,
      handler: async ({ task_id, path, label }) => updateTask(store, task_id, (task) => { task.artifacts.push({ path, label: label || basename(path), time: new Date().toISOString() }); }),
    }),
  };
}
