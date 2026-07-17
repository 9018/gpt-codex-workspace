/**
 * project-search-tools.mjs — Search tools for project control.
 *
 * @module project-search-tools
 */

export function createProjectSearchTools(deps) {
  return [
    {
      name: "project_grep",
      description: "Search for a pattern across files in the run's worktree.",
      handler: async ({ runId, pattern, path = "." } = {}) => {
        if (!pattern) throw new Error("pattern is required");
        const run = await deps.runStore.readRun(runId);
        const { execSync } = await import("node:child_process");
        const base = run.workspace_ref || process.cwd();
        try {
          const result = execSync(`rg -n "${pattern.replace(/"/g, '\\"')}" "${path}"`, { cwd: base, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
          const lines = result.trim().split("\n").filter(Boolean);
          return { ok: true, matches: lines.length, results: lines.slice(0, 200), truncated: lines.length > 200 };
        } catch (err) {
          if (err.status === 1) return { ok: true, matches: 0, results: [] };
          return { ok: false, error: err.message };
        }
      },
    },
  ];
}
