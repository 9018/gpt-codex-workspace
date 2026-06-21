import { appendAgentEvent, completeAgentRun, createAgentRun, getAgentRun, listAgentRuns, runAgentPipeline } from "../agent-run-service.mjs";
import { handoffToAgent, readHandoff, showChanges } from "../handoff-service.mjs";

export function createAgentRunToolsGroup({ tool, schema, store, config, eventLogger, hookBus }) {
  const common = { modes: ["standard", "codex", "full"], audience: ["chatgpt", "codex"], tags: ["agent", "handoff"] };
  return {
    create_agent_run: tool({
      name: "create_agent_run",
      description: "Create a tracked agent run linked to an optional goal/task.",
      inputSchema: schema({ goal_id: "string", task_id: "string", role: "string", agent: "string", status: "string", input_artifacts: "array", output_artifacts: "array", summary: "string" }),
      ...common,
      handler: (args) => createAgentRun(store, args, { eventLogger, hookBus }),
    }),
    list_agent_runs: tool({
      name: "list_agent_runs",
      description: "List tracked agent runs by goal, task, or status.",
      inputSchema: schema({ goal_id: "string", task_id: "string", status: "string", limit: "integer" }),
      ...common,
      handler: (args) => listAgentRuns(store, args),
    }),
    get_agent_run: tool({
      name: "get_agent_run",
      description: "Return a tracked agent run and its events.",
      inputSchema: schema({ agent_run_id: "string" }, ["agent_run_id"]),
      ...common,
      handler: (args) => getAgentRun(store, args),
    }),
    append_agent_event: tool({
      name: "append_agent_event",
      description: "Append a progress or audit event to an agent run.",
      inputSchema: schema({ agent_run_id: "string", type: "string", message: "string", data: "object" }, ["agent_run_id"]),
      ...common,
      handler: (args) => appendAgentEvent(store, args),
    }),
    complete_agent_run: tool({
      name: "complete_agent_run",
      description: "Mark an agent run completed or failed with summary and artifacts.",
      inputSchema: schema({ agent_run_id: "string", status: "string", summary: "string", output_artifacts: "array" }, ["agent_run_id"]),
      ...common,
      handler: (args) => completeAgentRun(store, args, { eventLogger, hookBus }),
    }),
    run_agent_pipeline: tool({
      name: "run_agent_pipeline",
      description: "Create a queued planner/implementer/tester/reviewer/finalizer agent run pipeline.",
      inputSchema: schema({ goal_id: "string", task_id: "string", agent: "string", roles: "array" }),
      ...common,
      handler: (args) => runAgentPipeline(store, args),
    }),
    handoff_to_agent: tool({
      name: "handoff_to_agent",
      description: "Write the current handoff plan and status artifacts for an external agent.",
      inputSchema: schema({ agent: "string", plan: "string", goal_id: "string", task_id: "string" }, ["plan"]),
      ...common,
      outputTemplate: "ui://widget/gptwork-card-v1.html",
      handler: (args) => handoffToAgent(config, args),
    }),
    read_handoff: tool({
      name: "read_handoff",
      description: "Read the current handoff plan, status, and artifact paths.",
      inputSchema: schema({}),
      ...common,
      handler: () => readHandoff(config),
    }),
    show_changes: tool({
      name: "show_changes",
      description: "Return a compact review summary of git changes with a bounded diff excerpt.",
      inputSchema: schema({ path: "string", max_diff_bytes: "integer" }),
      ...common,
      outputTemplate: "ui://widget/gptwork-card-v1.html",
      handler: (args) => showChanges(args, config),
    }),
  };
}
