import {
  createWorkstream,
  getWorkstream,
  listWorkstreams,
  updateWorkstream,
} from "../workstream/workstream-service.mjs";
import {
  linkWorkstreamContext,
  listWorkstreamLinks,
  resolveWorkstreamsByContext,
} from "../workstream/workstream-context-links.mjs";

export function createWorkstreamToolsGroup({ tool, schema, store }) {
  const common = {
    audience: ["chatgpt", "codex"],
    modes: ["standard", "codex", "full"],
    tags: ["workstream"],
    outputTemplate: "ui://widget/gptwork-card-v2.html",
    resourceUri: "ui://widget/gptwork-card-v2.html",
  };

  return {
    create_workstream: tool({
      name: "create_workstream",
      description: "Create a durable Workstream identity without replacing GPTWork internal conversations.",
      inputSchema: schema({
        id: "string",
        title: "string",
        project_id: "string",
        workspace_id: "string",
        repo_id: "string",
        root_goal_id: "string",
        workflow_id: "string",
        status: "string",
        summary: "string",
        execution_policy: "object",
        acceptance_policy: "object",
      }, ["title"]),
      ...common,
      handler: async (args, context) => ({ workstream: await createWorkstream(store, args, context) }),
    }),
    get_workstream: tool({
      name: "get_workstream",
      description: "Get one Workstream by durable ws_* identity.",
      inputSchema: schema({ workstream_id: "string" }, ["workstream_id"]),
      ...common,
      handler: async ({ workstream_id }, context) => ({ workstream: await getWorkstream(store, workstream_id, context) }),
    }),
    list_workstreams: tool({
      name: "list_workstreams",
      description: "List accessible Workstreams with optional identity and status filters.",
      inputSchema: schema({
        status: "string",
        project_id: "string",
        workspace_id: "string",
        repo_id: "string",
        root_goal_id: "string",
        workflow_id: "string",
        limit: "integer",
      }),
      ...common,
      handler: async (args, context) => {
        const workstreams = await listWorkstreams(store, args, context);
        return { workstreams, count: workstreams.length };
      },
    }),
    update_workstream: tool({
      name: "update_workstream",
      description: "Update mutable Workstream metadata and policies while preserving its identity.",
      inputSchema: schema({ workstream_id: "string", patch: "object" }, ["workstream_id", "patch"]),
      ...common,
      handler: async ({ workstream_id, patch }, context) => ({
        workstream: await updateWorkstream(store, workstream_id, patch, context),
      }),
    }),
    link_workstream_context: tool({
      name: "link_workstream_context",
      description: "Link an external or internal context identifier to a Workstream without changing conv_* conversation IDs.",
      inputSchema: schema({
        workstream_id: "string",
        kind: "string",
        external_id: "string",
        relation: "string",
        goal_id: "string",
        task_id: "string",
        metadata: "object",
      }, ["workstream_id", "kind", "external_id"]),
      ...common,
      handler: async (args, context) => ({ link: await linkWorkstreamContext(store, args, context) }),
    }),
    list_workstream_links: tool({
      name: "list_workstream_links",
      description: "List typed context links for a Workstream or context identifier.",
      inputSchema: schema({
        workstream_id: "string",
        kind: "string",
        external_id: "string",
        relation: "string",
        goal_id: "string",
        task_id: "string",
        limit: "integer",
      }),
      ...common,
      handler: async (args, context) => {
        const links = await listWorkstreamLinks(store, args, context);
        return { links, count: links.length };
      },
    }),
    resolve_workstream_by_context: tool({
      name: "resolve_workstream_by_context",
      description: "Resolve all accessible Workstreams linked to one typed external or internal context identifier.",
      inputSchema: schema({ kind: "string", external_id: "string" }, ["kind", "external_id"]),
      ...common,
      handler: async ({ kind, external_id }, context) => resolveWorkstreamsByContext(store, kind, external_id, context),
    }),
  };
}
