export function createGoalToolsGroup({ tool, schema, config, store, createGoal, createEncodedGoal, listGoals, getGoalContext, appendGoalMessage }) {
  return {
    create_goal: tool(
      'Create a shared goal from a ChatGPT-written goal prompt. Use this when ChatGPT turns the user\'s request into a Codex-executable goal. Stores the raw request, goal prompt, conversation messages, durable memories, workspace-visible context files, and optionally creates an assigned Codex task linked to the same context.',
      schema({ user_request: 'string', goal_prompt: 'string', context_summary: 'string', project_id: 'string', workspace_id: 'string', mode: 'string', assign_to_codex: 'boolean', title: 'string', messages: 'array', memories: 'array', payload: 'object', payload_base64: 'string', preview_text: 'string', bundles: 'array' }, ['user_request', 'goal_prompt']),
      async (args, context) => createGoal(store, config, args, context),
    ),
    create_encoded_goal: tool(
      'Create a shared Codex goal from a GPTChat preview plus base64-encoded JSON payload. The server decodes the payload, stores readable goal/context/transcript files, assigns Codex when requested, and can wait briefly for execution status with wait_ms.',
      schema({ preview_text: 'string', payload_base64: 'string', assign_to_codex: 'boolean', wait_ms: 'integer' }, ['preview_text', 'payload_base64']),
      async (args, context) => createEncodedGoal(store, config, args, context),
    ),
    list_goals: tool(
      'List shared GPTWork goals for ChatGPT and Codex. Codex should use this to discover assigned or open goal prompts before starting work.',
      schema({ status: 'string', assignee: 'string', workspace_id: 'string', limit: 'integer' }),
      async (args, context) => listGoals(store, args, context),
    ),
    get_goal_context: tool(
      'Return the full shared goal context: goal prompt, raw user request, conversation messages, durable memories, linked Codex task, and workspace-visible context files. Codex should call this before acting on a goal or linked task.',
      schema({ goal_id: 'string', task_id: 'string' }, []),
      async (args, context) => getGoalContext(store, config, args, context),
    ),
    append_goal_message: tool(
      'Append a ChatGPT, user, or Codex message to a shared goal conversation and optionally store a memory item for future Codex context. Also updates the workspace transcript/context files.',
      schema({ goal_id: 'string', task_id: 'string', role: 'string', content: 'string', memory_key: 'string', memory_value: 'string' }, ['content']),
      async (args, context) => appendGoalMessage(store, config, args, context),
    ),
  };
}
