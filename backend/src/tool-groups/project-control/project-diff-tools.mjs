/**
 * project-diff-tools.mjs — Git diff tools for project control.
 *
 * @module project-diff-tools
 */

/**
 * Create diff tools.
 *
 * @param {object} deps
 * @returns {object[]} Tool definitions
 */
export function createProjectDiffTools(deps) {
  return [
    {
      name: "project_git_diff",
      description: "Show the current git diff in the run's worktree.",
      handler: async ({ runId, path = "." } = {}) => {
        const run = await deps.runStore.readRun(runId);
        const { execSync } = await import("node:child_process");
        const base = run.workspace_ref || process.cwd();
        try {
          const diff = execSync("git diff", { cwd: base, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
          const stat = execSync("git diff --stat", { cwd: base, encoding: "utf8" });
          return { ok: true, diff: diff || "(clean)", stat: stat || "(no changes)", path: base };
        } catch (err) {
          return { ok: false, error: err.message, path: base };
        }
      },
    },
    {
      name: "project_git_log",
      description: "Show recent git log in the run's worktree.",
      handler: async ({ runId, count = 10 } = {}) => {
        const run = await deps.runStore.readRun(runId);
        const { execSync } = await import("node:child_process");
        const base = run.workspace_ref || process.cwd();
        try {
          const log = execSync(`git log --oneline -${Math.min(count, 50)}`, { cwd: base, encoding: "utf8" });
          return { ok: true, log: log || "(no commits)", path: base };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },
  ];
}
