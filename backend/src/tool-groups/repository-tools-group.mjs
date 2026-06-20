import { getRepoStatus } from "../repo-registry.mjs";

/**
 * Scoped MCP tool group: repository registry and status tools.
 * Handlers expose repository registration, listing, status, and canonical resolution
 * backed by RepoRegistry and getRepoStatus from repo-registry.mjs.
 */
export function createRepositoryToolsGroup({ tool, schema, registry }) {
  return {
    register_repository: tool("Register a repository in the workspace registry so Codex can find it via canonical path instead of stale temporary clones.", schema({ remote_url: "string", canonical_path: "string", default_branch: "string", roles: "string", tags: "string", status: "string" }, ["remote_url"]), async (args) => {
      const info = {
        remote_url: args.remote_url,
        canonical_path: args.canonical_path || null,
        default_branch: args.default_branch || null,
        roles: args.roles ? args.roles.split(",").map(s => s.trim()).filter(Boolean) : [],
        tags: args.tags ? args.tags.split(",").map(s => s.trim()).filter(Boolean) : [],
        status: args.status || "active",
      };
      const record = await registry.register(info);
      return { ok: true, record };
    }),

    list_repositories: tool("List all registered repositories in the workspace registry with canonical paths.", schema({}), async () => {
      const repos = registry.list();
      return { count: repos.length, repositories: repos };
    }),

    get_repository_status: tool("Get detailed status for a registered repository, including canonical/stale detection and ahead/behind. If no repo_id/owner/repo_name is provided and there is exactly one registered repo, it will be used automatically. Multi-repo projects must specify repo_id.", schema({ repo_id: "string", owner: "string", repo_name: "string" }, []), async (args) => {
      let record = null;
      if (args.repo_id) {
        record = registry.get(args.repo_id);
      } else if (args.owner && args.repo_name) {
        record = registry.findByName(args.owner, args.repo_name);
      } else {
        record = registry.getDefaultRepo();
      }
      if (!record) {
        const count = registry.count();
        if (count === 0) return { error: "No repositories registered. Use register_repository first.", repositories: [] };
        if (count > 1) return { error: "Multiple repositories registered. Please specify repo_id, owner/repo, or repo_name.", repositories: registry.list().map(r => ({ repo_id: r.repo_id, owner: r.owner, repo_name: r.repo_name })) };
        return { error: "Repository not found." };
      }
      const status = await getRepoStatus(record, registry.workspaceRoot, registry);
      return status;
    }),

    resolve_canonical_repository: tool("Resolve which repository to use for the current task context. If exactly one repo is registered, returns it; if multiple, returns the best match or asks for repo_id. Call this before doing repo work.", schema({ repo_id: "string", owner: "string", repo_name: "string" }, []), async (args) => {
      let record = null;
      if (args.repo_id) {
        record = registry.get(args.repo_id);
      } else if (args.owner && args.repo_name) {
        record = registry.findByName(args.owner, args.repo_name);
      } else {
        record = registry.getDefaultRepo();
      }
      if (!record) {
        const count = registry.count();
        if (count === 0) return { error: "No repositories registered. Use register_repository first.", repositories: [] };
        if (count > 1) return { error: "Multiple repositories registered. Please specify repo_id, owner/repo, or repo_name. Available: " + registry.list().map(r => r.repo_id).join(", ") };
        return { error: "Repository not found." };
      }
      return { ok: true, repo_id: record.repo_id, canonical_path: record.canonical_path, remote_url: record.remote_url, default_branch: record.default_branch, owner: record.owner, repo_name: record.repo_name };
    }),
  };
}
