/**
 * goal-queue-tools-group.mjs — MCP tool registrations for goal/task queue execution.
 *
 * Tools:
 *   enqueue_goal          - Add an open goal to the execution queue
 *   list_goal_queue       - List queue items (filterable, sorted by position)
 *   get_goal_queue        - Get a single queue item by queue_id
 *   start_next_queued_goal - Start the next eligible queued goal
 *   update_goal_queue_item - Update a queue item's status/fields
 *   cancel_goal_queue_item - Cancel a queue item
 *
 * Tool mode exposure:
 *   standard, codex, full: All tools visible
 *   minimal: Not visible
 *   operator: Read-only tools (list, get)
 */

export function createGoalQueueToolsGroup({ tool, schema, store, config, goalQueue }) {
  const common = { audience: ["chatgpt", "codex"], tags: ["goal", "queue"], outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html" };

  return {
    enqueue_goal: tool({
      name: "enqueue_goal",
      description: "Add an existing open goal to the execution queue. The goal must exist in state (created via create_goal/create_encoded_goal). Once enqueued, the goal enters the queue at the next position with status=waiting. Use start_next_queued_goal to begin execution when dependencies are satisfied and the repo is not locked. Optionally set depends_on_goal_id or depends_on_task_id to create execution ordering.",
      inputSchema: schema({
        goal_id: { type: "string", description: "ID of the goal to enqueue (e.g. goal_xxx).", examples: ["goal_51da0e55-3395-41b2-8200-fddf6c7045f7"] },
        depends_on_goal_id: { type: "string", description: "Optional: ID of a goal that must complete before this one starts.", examples: [] },
        depends_on_task_id: { type: "string", description: "Optional: ID of a task that must complete before this one starts.", examples: [] },
        auto_start: { type: "boolean", description: "Whether to auto-start this item when the previous task completes. Default: true.", default: true },
        workspace_id: { type: "string", description: "Workspace ID. Defaults to the goal's workspace.", default: "hosted-default" },
        repo_id: { type: "string", description: "Repository identifier for concurrency management.", default: "" },
      }, ["goal_id"]),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        return goalQueue.enqueueGoal(store, args.goal_id, {
          depends_on_goal_id: args.depends_on_goal_id,
          depends_on_task_id: args.depends_on_task_id,
          auto_start: args.auto_start !== false,
          workspace_id: args.workspace_id,
          repo_id: args.repo_id,
        });
      },
    }),

    list_goal_queue: tool({
      name: "list_goal_queue",
      description: "List execution queue items, sorted by position (ascending). Supports optional filtering by status, workspace_id, or repo_id. Each item includes the queued goal_id, its current status (waiting|ready|running|blocked|completed|failed|cancelled), position, dependency info, and the linked goal title. Use status=waiting or status=ready to find eligible items for start_next_queued_goal.",
      inputSchema: schema({
        status: { type: "string", description: "Filter by status (waiting|ready|running|blocked|completed|failed|cancelled).", examples: ["waiting"] },
        workspace_id: { type: "string", description: "Filter by workspace ID.", examples: ["hosted-default"] },
        repo_id: { type: "string", description: "Filter by repository identifier.", examples: [] },
        limit: { type: "integer", description: "Maximum number of items to return.", minimum: 1, maximum: 200, default: 50 },
      }, []),
      modes: ["standard", "codex", "full", "operator"],
      ...common,
      handler: async (args, context) => {
        return goalQueue.listGoalQueue(store, {
          status: args.status,
          workspace_id: args.workspace_id,
          repo_id: args.repo_id,
          limit: args.limit ? Number(args.limit) : 50,
        });
      },
    }),

    get_goal_queue: tool({
      name: "get_goal_queue",
      description: "Get a single execution queue item by its queue_id. Returns the full item details including goal_id, task_id (if started), position, status, dependency info, blocked_reason, and auto_start flag.",
      inputSchema: schema({
        queue_id: { type: "string", description: "Queue item ID (e.g. queue_xxx).", examples: [] },
      }, ["queue_id"]),
      modes: ["standard", "codex", "full", "operator"],
      ...common,
      handler: async (args, context) => {
        const item = await goalQueue.getGoalQueueItem(store, args.queue_id);
        if (!item) return { ok: false, item: null, warnings: [`Queue item not found: ${args.queue_id}`] };
        return { ok: true, item };
      },
    }),

    start_next_queued_goal: tool({
      name: "start_next_queued_goal",
      description: "Scan the queue for the next eligible item and start it. Eligibility checks (in order): dependency satisfied, no active repo lock for a different task, clean worktree. If all checks pass, creates a new Codex-assigned task for the goal. Use dry_run=true to preview which item would be started without actually starting it. Returns the started task and queue item, plus individual check results.",
      inputSchema: schema({
        dry_run: { type: "boolean", description: "If true, report what would be started without actually starting it.", default: false },
      }, []),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        return goalQueue.startNextQueuedGoal(store, config, {
          dry_run: args.dry_run === true,
        });
      },
    }),

    update_goal_queue_item: tool({
      name: "update_goal_queue_item",
      description: "Update a queue item's mutable fields: status, blocked_reason, auto_start, position, depends_on_goal_id, depends_on_task_id, or repo_id. Use this to manually unblock an item by adjusting its status back to waiting/ready, or to change dependency targets.",
      inputSchema: schema({
        queue_id: { type: "string", description: "Queue item ID to update.", examples: [] },
        status: { type: "string", description: "New status (waiting|ready|running|blocked|completed|failed|cancelled).", examples: ["ready"] },
        blocked_reason: { type: "string", description: "Reason if status=blocked.", examples: [] },
        auto_start: { type: "boolean", description: "Whether to auto-start when previous completes.", examples: [] },
        position: { type: "integer", description: "Queue position for ordering.", examples: [] },
        depends_on_goal_id: { type: "string", description: "Dependency goal ID.", examples: [] },
        depends_on_task_id: { type: "string", description: "Dependency task ID.", examples: [] },
      }, ["queue_id"]),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        const updater = {};
        const fields = ["status", "blocked_reason", "auto_start", "position", "depends_on_goal_id", "depends_on_task_id", "repo_id"];
        for (const f of fields) {
          if (args[f] !== undefined) updater[f] = args[f];
        }
        return goalQueue.updateGoalQueueItem(store, args.queue_id, updater);
      },
    }),

    cancel_goal_queue_item: tool({
      name: "cancel_goal_queue_item",
      description: "Cancel a queue item by setting its status to cancelled. Only items that are not currently running can be cancelled. To cancel a running queue item, cancel the associated task first, then cancel the queue item.",
      inputSchema: schema({
        queue_id: { type: "string", description: "Queue item ID to cancel.", examples: [] },
      }, ["queue_id"]),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        return goalQueue.cancelGoalQueueItem(store, args.queue_id);
      },
    }),
  };
}
