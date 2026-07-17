/**
 * project-read-tools.mjs — Read-only project file tools (within worktree).
 *
 * @module project-read-tools
 */

/**
 * Create read-only project tools.
 *
 * @param {object} deps
 * @param {object} deps.runStore - ExecutionRun store
 * @returns {object[]} Tool definitions
 */
export function createProjectReadTools(deps) {
  return [
    {
      name: "project_read_file",
      description: "Read a file from within the execution run's worktree directory.",
      handler: async ({ runId, path } = {}) => {
        if (!path) throw new Error("path is required");
        const run = await deps.runStore.readRun(runId);
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const base = run.workspace_ref || process.cwd();
        const fullPath = join(base, path);
        const content = await readFile(fullPath, "utf8");
        return { ok: true, path: fullPath, content, size: content.length };
      },
    },
    {
      name: "project_list_files",
      description: "List files in a directory within the run's worktree.",
      handler: async ({ runId, path = "." } = {}) => {
        const run = await deps.runStore.readRun(runId);
        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const base = run.workspace_ref || process.cwd();
        const fullPath = join(base, path);
        const entries = await readdir(fullPath, { withFileTypes: true });
        return {
          ok: true, path: fullPath,
          files: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" })),
        };
      },
    },
  ];
}
