import { randomUUID } from "node:crypto";

/**
 * Factory for ChatGPT coordination request MCP tool registration.
 * Dependencies are passed in to avoid circular imports from gptwork-server.mjs.
 */
export function createChatGptRequestToolsGroup({ tool, schema, config, store, github }) {
  return {
    create_chatgpt_request: tool(
      "Ask ChatGPT a question or request analysis. Use when Codex needs human input, product direction, design feedback, or a tricky judgment call. ChatGPT sees this and responds. Syncs to GitHub Issues if configured.",
      schema({ title: "string", prompt: "string", source: "string", task_id: "string", workspace_id: "string", escalation_category: "string", why_subagents_cannot_decide: "string", options_considered: "string", default_if_no_response: "string" }, ["title", "prompt"]),
      async (args) => {
        // P1.4: Require structured escalation reason
        let warnings = [];
        // Build escalation object from flat schema fields (schema() cannot express nested objects)
        const escalated = args.escalation_category || args.why_subagents_cannot_decide || args.options_considered || args.default_if_no_response;
        const escalation = escalated ? { category: args.escalation_category || "", why_subagents_cannot_decide: args.why_subagents_cannot_decide || "", options_considered: args.options_considered || "", default_if_no_response: args.default_if_no_response || "" } : undefined;
        const hasEscalation = escalation && escalation.category;
        if (!hasEscalation) {
          warnings.push("Missing structured escalation reason. Codex should include escalation_category, why_subagents_cannot_decide, options_considered (JSON array as string), and default_if_no_response when asking ChatGPT.");
        }
        const result = await createChatGptRequest(store, { ...args, escalation });
        github.syncChatGptRequest(result.request).catch(() => {});
        return warnings.length > 0 ? { ...result, warnings } : result;
      },
    ),
    list_chatgpt_requests: tool(
      "List coordination requests from Codex needing ChatGPT attention. Open requests mean Codex is waiting for your analysis, decision, or input.",
      schema({ status: "string", source: "string", limit: "integer" }),
      async ({ status, source, limit = 50 }) => {
        const state = await store.load();
        state.chatgpt_requests ||= [];
        let requests = state.chatgpt_requests;
        if (status) requests = requests.filter((request) => request.status === status);
        if (source) requests = requests.filter((request) => request.source === source);
        return { requests: requests.slice(-limit).reverse() };
      },
    ),
    get_chatgpt_request: tool(
      "Return a ChatGPT coordination request.",
      schema({ request_id: "string" }, ["request_id"]),
      async ({ request_id }) => ({ request: await findChatGptRequest(store, request_id) }),
    ),
    answer_chatgpt_request: tool(
      "Record ChatGPT response to a coordination request. Use this to attach ChatGPT analysis or decision so Codex can continue working.",
      schema({ request_id: "string", response: "string" }, ["request_id", "response"]),
      async ({ request_id, response }) => {
        const result = await updateChatGptRequest(store, request_id, (request) => { request.status = "answered"; request.response = response; request.answered_at = new Date().toISOString(); });
        github.syncChatGptRequest(result.request).catch(() => {});
        return result;
      },
    ),
  };
}

// --- Helper functions (moved from gptwork-server.mjs, preserved exactly) ---

async function createChatGptRequest(store, args) {
  const state = await store.load();

  // P1.3: Track GPT-question budget usage
  if (args.task_id) {
    const linkedTask = typeof store.findTaskById === "function"
      ? await store.findTaskById(args.task_id)
      : state.tasks.find(t => t.id === args.task_id);
    if (linkedTask && linkedTask.goal_id) {
      const goal = typeof store.findGoalById === "function"
        ? await store.findGoalById(linkedTask.goal_id)
        : state.goals.find(g => g.id === linkedTask.goal_id);
      if (goal) {
        goal.gpt_questions_used = (goal.gpt_questions_used || 0) + 1;
        const budget = goal.autonomy_policy?.gpt_question_budget ?? 0;
        if (goal.gpt_questions_used > budget) {
          const warnMsg = `GPT question budget exceeded: ${goal.gpt_questions_used} used, budget ${budget}`;
          state.activities.push({ time: new Date().toISOString(), type: "gpt_budget.warning", goal_id: goal.id, message: warnMsg });
        }
      }
    }
  }

  state.chatgpt_requests ||= [];
  const now = new Date().toISOString();
  const request = {
    id: `chatreq_${randomUUID()}`,
    project_id: args.project_id || "default",
    workspace_id: args.workspace_id || "hosted-default",
    task_id: args.task_id || null,
    title: args.title,
    prompt: args.prompt,
    source: args.source || "codex",
    escalation: args.escalation || null,
    status: "open",
    response: "",
    created_at: now,
    updated_at: now,
  };
  state.chatgpt_requests.push(request);
  state.activities.push({ time: now, type: "chatgpt_request.created", request_id: request.id, title: request.title });
  await store.save();
  return { request };
}

async function findChatGptRequest(store, request_id) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  return request;
}

async function updateChatGptRequest(store, request_id, updater) {
  const state = await store.load();
  state.chatgpt_requests ||= [];
  const request = state.chatgpt_requests.find((item) => item.id === request_id);
  if (!request) throw new Error(`ChatGPT request not found: ${request_id}`);
  updater(request);
  request.updated_at = new Date().toISOString();
  state.activities.push({ time: request.updated_at, type: "chatgpt_request.updated", request_id, status: request.status });
  await store.save();
  return { request };
}
