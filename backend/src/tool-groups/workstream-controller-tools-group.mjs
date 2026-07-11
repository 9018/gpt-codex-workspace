/**
 * workstream-controller-tools-group.mjs — MCP tool registrations
 * for the workstream acceptance controller, tick, drift/stall detection,
 * and repair task factory.
 *
 * Exposes the following tools:
 *   evaluate_workstream_acceptance   - Run acceptance evaluation on a task
 *   run_workstream_tick              - Run one tick of the controller
 *   detect_workstream_drift          - Detect drift conditions
 *   detect_workstream_stall          - Detect stall conditions
 *   schedule_workstream_repair       - Schedule repair action based on verdict
 *   get_workstream_controller_status - Get controller + tick status summary
 *
 * Tool mode exposure: standard, codex, full
 * Audience: chatgpt, codex
 */

// ---------------------------------------------------------------------------
// createWorkstreamControllerToolsGroup
// ---------------------------------------------------------------------------

export function createWorkstreamControllerToolsGroup({ tool, schema, store }) {
  const common = {
    audience: ["chatgpt", "codex"],
    modes: ["standard", "codex", "full"],
    tags: ["workstream", "controller", "acceptance", "tick"],
    outputTemplate: "ui://widget/gptwork-card-v2.html",
    resourceUri: "ui://widget/gptwork-card-v2.html",
  };

  return {
    // -----------------------------------------------------------------------
    // evaluate_workstream_acceptance
    // -----------------------------------------------------------------------
    evaluate_workstream_acceptance: tool({
      name: "evaluate_workstream_acceptance",
      description: "Evaluate acceptance for a workstream task. Checks result/artifact, Git clean/commit, tests, changed scope, reviewer decision, and documentation updates. Returns verdict: passed/failed/partial/blocked. Idempotent: same evidence always returns same verdict.",
      inputSchema: schema({
        task_id: { type: "string", description: "Task ID to evaluate" },
        task: { type: "object", description: "Task record (if task_id not used)" },
        goal: { type: "object", description: "Goal record" },
        result: { type: "object", description: "Task result (result.json payload)" },
        verification: { type: "object", description: "Verification evidence" },
        contract: { type: "object", description: "Acceptance contract" },
        git_state: { type: "object", description: "Git state: { dirty, diff_empty, commit }" },
      }, []),
      ...common,
      handler: async (args, context) => {
        const { evaluateAcceptance } = await import("../acceptance/workstream-acceptance-decision.mjs");

        // Resolve task from store if task_id provided
        let task = args.task || {};
        let goal = args.goal || {};
        if (args.task_id && store) {
          try {
            const state = await store.load();
            task = state.tasks?.find((t) => t.id === args.task_id) || task;
            if (task.goal_id) {
              goal = state.goals?.find((g) => g.id === task.goal_id) || goal;
            }
          } catch {}
        }

        const result = evaluateAcceptance({
          task,
          goal,
          result: args.result || task.result || {},
          verification: args.verification || task.result?.verification || {},
          contract: args.contract || goal.acceptance_contract || {},
          gitState: args.git_state || {},
        });

        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // run_workstream_tick
    // -----------------------------------------------------------------------
    run_workstream_tick: tool({
      name: "run_workstream_tick",
      description: "Run one tick of the workstream controller. Processes up to 5 state transitions: drift detection, stall detection, acceptance evaluation, task advancement, and review reconciliation. Idempotent: same state produces same tick result.",
      inputSchema: schema({
        workstream_id: { type: "string", description: "Workstream ID (ws_*)" },
        workstream: { type: "object", description: "Workstream record fallback" },
        tasks: { type: "array", items: { type: "object" }, description: "Task records" },
        goal: { type: "object", description: "Goal record" },
        progress: { type: "object", description: "Structured progress data" },
        tui_session: { type: "object", description: "TUI session data" },
        lock: { type: "object", description: "Lock data" },
        parent_task: { type: "object", description: "Parent task" },
        review_backlog: { type: "array", items: { type: "object" }, description: "Review backlog items" },
        corrections: { type: "array", items: { type: "object" }, description: "Direct correction candidates" },
        max_transitions: { type: "integer", description: "Max state transitions (default 5)" },
      }, []),
      ...common,
      handler: async (args, context) => {
        const { runTick } = await import("../orchestration/workstream-tick.mjs");
        const { detectDrift } = await import("../orchestration/workstream-drift-detector.mjs");
        const { detectStall } = await import("../orchestration/workstream-stall-detector.mjs");

        let workstream = args.workstream || {};
        if (args.workstream_id && store) {
          try {
            workstream = (await store.findWorkstreamById(args.workstream_id)) || workstream;
          } catch {}
        }

        // Load state for repair records
        let state = {};
        try {
          state = await store.load();
        } catch {}

        const result = await runTick({
          workstream,
          tasks: args.tasks || [],
          goal: args.goal || {},
          progress: args.progress || {},
          tuiSession: args.tui_session || {},
          lock: args.lock || {},
          parentTask: args.parent_task || {},
          reviewBacklog: args.review_backlog || [],
          corrections: args.corrections || [],
          state,
          maxTransitions: args.max_transitions,
        });

        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // detect_workstream_drift
    // -----------------------------------------------------------------------
    detect_workstream_drift: tool({
      name: "detect_workstream_drift",
      description: "Detect workstream drift conditions: wrong phase, wrong scope, stale progress, and terminal task/queue mismatch. Returns typed drift findings. Idempotent: same state produces same findings.",
      inputSchema: schema({
        task: { type: "object", description: "Task record" },
        workstream: { type: "object", description: "Workstream record" },
        parent_task: { type: "object", description: "Parent task" },
        progress: { type: "object", description: "Progress.json data" },
        expected_phase: { type: "string", description: "Expected phase" },
        expected_scopes: { type: "array", items: { type: "string" }, description: "Expected scopes" },
        stale_threshold_hours: { type: "integer", description: "Hours before progress is stale (default 2)" },
      }, []),
      ...common,
      handler: async (args, context) => {
        const { detectDrift } = await import("../orchestration/workstream-drift-detector.mjs");
        const result = detectDrift({
          task: args.task || {},
          workstream: args.workstream || {},
          parentTask: args.parent_task || {},
          progress: args.progress || {},
          expectedPhase: args.expected_phase || "",
          expectedScopes: args.expected_scopes || [],
          staleThresholdHours: args.stale_threshold_hours != null ? Number(args.stale_threshold_hours) : 2,
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // detect_workstream_stall
    // -----------------------------------------------------------------------
    detect_workstream_stall: tool({
      name: "detect_workstream_stall",
      description: "Detect workstream stall conditions: dead TUI session, stale worker, stale lock, and terminal task/queue mismatch. Returns typed stall findings. Idempotent: same state produces same findings.",
      inputSchema: schema({
        task: { type: "object", description: "Task record" },
        tui_session: { type: "object", description: "TUI session object" },
        lock: { type: "object", description: "Lock object" },
        parent_task: { type: "object", description: "Parent task" },
        sibling_tasks: { type: "array", items: { type: "object" }, description: "Sibling task records" },
        max_heartbeat_age_minutes: { type: "integer", description: "Max TUI heartbeat age (default 10)" },
        max_output_idle_minutes: { type: "integer", description: "Max TUI output idle (default 30)" },
        max_worker_idle_minutes: { type: "integer", description: "Max worker idle (default 15)" },
        max_lock_age_minutes: { type: "integer", description: "Max lock age (default 60)" },
      }, []),
      ...common,
      handler: async (args, context) => {
        const { detectStall } = await import("../orchestration/workstream-stall-detector.mjs");
        const result = detectStall({
          task: args.task || {},
          tuiSession: args.tui_session || {},
          lock: args.lock || {},
          parentTask: args.parent_task || {},
          siblingTasks: args.sibling_tasks || [],
          maxHeartbeatAgeMinutes: args.max_heartbeat_age_minutes != null ? Number(args.max_heartbeat_age_minutes) : 10,
          maxOutputIdleMinutes: args.max_output_idle_minutes != null ? Number(args.max_output_idle_minutes) : 30,
          maxWorkerIdleMinutes: args.max_worker_idle_minutes != null ? Number(args.max_worker_idle_minutes) : 15,
          maxLockAgeMinutes: args.max_lock_age_minutes != null ? Number(args.max_lock_age_minutes) : 60,
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // schedule_workstream_repair
    // -----------------------------------------------------------------------
    schedule_workstream_repair: tool({
      name: "schedule_workstream_repair",
      description: "Schedule a repair action based on acceptance verdict. Returns repair goal, convergence goal, ChatGPT escalation, or direct correction payload. Idempotent: repeated input with same root_task_id+kind+attempt will not duplicate records.",
      inputSchema: schema({
        task: { type: "object", description: "Task record" },
        goal: { type: "object", description: "Goal record" },
        acceptance_decision: { type: "object", description: "Decision from evaluate_workstream_acceptance" },
        repair_records: { type: "array", items: { type: "object" }, description: "Existing repair records" },
        corrections: { type: "array", items: { type: "object" }, description: "Direct correction candidates" },
        current_attempt: { type: "integer", description: "Current repair attempt count" },
      }, ["acceptance_decision"]),
      ...common,
      handler: async (args, context) => {
        const { scheduleRepairAction } = await import("../acceptance/workstream-repair-task-factory.mjs");
        const result = scheduleRepairAction({
          task: args.task || {},
          goal: args.goal || {},
          acceptanceDecision: args.acceptance_decision || {},
          repairRecords: args.repair_records || [],
          corrections: args.corrections || [],
          currentAttempt: args.current_attempt != null ? Number(args.current_attempt) : 0,
        });
        return result;
      },
    }),

    // -----------------------------------------------------------------------
    // get_workstream_controller_status
    // -----------------------------------------------------------------------
    get_workstream_controller_status: tool({
      name: "get_workstream_controller_status",
      description: "Get aggregated status for the workstream controller: last tick, drift/stall state, active repairs, and repair records count.",
      inputSchema: schema({
        workstream_id: { type: "string", description: "Workstream ID (ws_*)" },
        workstream: { type: "object", description: "Workstream record fallback" },
      }, []),
      ...common,
      handler: async (args, context) => {
        let workstream = args.workstream || {};
        let state = { tasks: [], goals: [] };
        if (store) {
          try {
            state = await store.load();
            if (args.workstream_id) {
              workstream = (await store.findWorkstreamById(args.workstream_id)) || workstream;
            }
          } catch {}
        }

        const tasks = state.tasks || [];
        const goals = state.goals || [];
        const repairRecords = Array.isArray(state.workstream_repair_records) ? state.workstream_repair_records : [];
        const activeRepairs = repairRecords.filter((r) => r.kind === "repair_task" || r.kind === "convergence_goal");
        const terminalTasks = tasks.filter((t) => ["completed", "failed", "timed_out", "cancelled"].includes(t.status));
        const activeTasks = tasks.filter((t) => !["completed", "failed", "timed_out", "cancelled"].includes(t.status));

        return {
          workstream_id: workstream.id || args.workstream_id || null,
          workstream_status: workstream.status || null,
          tasks_total: tasks.length,
          tasks_active: activeTasks.length,
          tasks_terminal: terminalTasks.length,
          goals_total: goals.length,
          repair_records_count: repairRecords.length,
          active_repairs: activeRepairs.length,
          active_repair_records: activeRepairs.map((r) => ({
            kind: r.kind,
            root_task_id: r.root_task_id,
            attempt: r.attempt,
            created_at: r.created_at,
            failure_class: r.failure_class,
          })),
          timestamp: new Date().toISOString(),
        };
      },
    }),
  };
}
