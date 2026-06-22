export function createGoalToolsGroup({ tool, schema, config, store, eventLogger, hookBus, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }) {
  const common = { audience: ["chatgpt", "codex"], tags: ["goal"], outputTemplate: "ui://widget/gptwork-card-v1.html" };
  return {
    create_goal: tool({
      name: "create_goal",
      description: "Create a shared goal from a ChatGPT-written goal prompt. Use this when ChatGPT turns the user's request into a Codex-executable goal. Stores the raw request, goal prompt, conversation messages, durable memories, workspace-visible context files, and optionally creates an assigned Codex task linked to the same context.",
      inputSchema: schema({ user_request: 'string', goal_prompt: 'string', context_summary: 'string', project_id: 'string', workspace_id: 'string', mode: 'string', assign_to_codex: 'boolean', title: 'string', messages: 'array', memories: 'array', payload: 'object', payload_base64: 'string', preview_text: 'string', bundles: 'array' }, ['user_request', 'goal_prompt']),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        const result = await createGoal(store, config, args, context);
        await eventLogger?.append("goal.created", { goal_id: result.goal.id, title: result.goal.title });
        await hookBus?.emit("onGoalCreated", { goal: result.goal });
        return result;
      },
    }),
    create_encoded_goal: tool({
      name: "create_encoded_goal",
      description: "Create a shared Codex goal from a GPTChat preview plus base64-encoded JSON payload. The server decodes the payload, stores readable goal/context/transcript files, assigns Codex when requested, and can wait briefly for execution status with wait_ms.",
      inputSchema: schema({
        preview_text: { type: "string", description: "GPT-written preview text summarizing what the goal is about.", examples: ["Implement feature X"] },
        payload_base64: { type: "string", description: "Base64-encoded JSON payload containing goal_prompt, context_summary, messages, and other goal fields." },
        assign_to_codex: { type: "boolean", description: "Whether to immediately assign this goal to Codex for execution.", default: true },
        wait_ms: { type: "integer", description: "How long to wait (in ms) for initial Codex execution status before returning.", minimum: 0, maximum: 120000, default: 90000 }
      }, ["preview_text", "payload_base64"]),
      modes: ["minimal", "standard", "codex", "full"],
      ...common,
      handler: async (args, context) => {
        const result = await createEncodedGoal(store, config, args, context);
        await eventLogger?.append("goal.created", { goal_id: result.goal.id, title: result.goal.title, encoded: true });
        await hookBus?.emit("onGoalCreated", { goal: result.goal, encoded: true });
        return result;
      },
    }),
    list_goals: tool({
      name: "list_goals",
      description: "List shared GPTWork goals for ChatGPT and Codex. Codex should use this to discover assigned or open goal prompts before starting work.",
      inputSchema: schema({ status: 'string', assignee: 'string', workspace_id: 'string', limit: 'integer' }),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => listGoals(store, args, context),
    }),
    get_goal_context: tool({
      name: "get_goal_context",
      description: "Return the full shared goal context: goal prompt, raw user request, conversation messages, durable memories, linked Codex task, and workspace-visible context files. Codex should call this before acting on a goal or linked task.",
      inputSchema: schema({ goal_id: 'string', task_id: 'string' }, []),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => getGoalContext(store, config, args, context),
    }),
    append_goal_message: tool({
      name: "append_goal_message",
      description: "Append a ChatGPT, user, or Codex message to a shared goal conversation and optionally store a memory item for future Codex context. Also updates the workspace transcript/context files.",
      inputSchema: schema({ goal_id: 'string', task_id: 'string', role: 'string', content: 'string', memory_key: 'string', memory_value: 'string' }, ['content']),
      modes: ["standard", "codex", "full"],
      ...common,
      handler: async (args, context) => appendGoalMessage(store, config, args, context),
    }),
  };
}
