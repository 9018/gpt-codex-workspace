import { collectProjectContext } from "../project-context-service.mjs";

export function createProjectContextToolsGroup({ tool, schema, config, store, workerState, registry }) {
  return {
    open_project_context: tool({
      name: "open_project_context",
      description: "Open a compact first-step GPTWork project context: repo state, config, project files, recent goals/tasks, worker status, scripts, bounded tree, and recommended next tools.",
      inputSchema: schema({}),
      modes: ["minimal", "standard", "codex", "full"],
      audience: ["chatgpt", "codex"],
      tags: ["project", "context", "status"],
      outputCard: "projectContextCard",
      outputTemplate: "ui://widget/gptwork-card-v2.html",
      resourceUri: "ui://widget/gptwork-card-v2.html",
      handler: async () => collectProjectContext({ config, store, workerState, registry }),
    }),
  };
}
