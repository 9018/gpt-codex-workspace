/**
 * project-patch-tools.mjs — File patching tools for project control.
 *
 * @module project-patch-tools
 */

/**
 * Create patch tools.
 *
 * @param {object} deps
 * @returns {object[]} Tool definitions
 */
export function createProjectPatchTools(deps) {
  return [
    {
      name: "project_write_file",
      description: "Write content to a file within the run's worktree.",
      handler: async ({ runId, path, content } = {}) => {
        if (!path) throw new Error("path is required");
        if (content === undefined) throw new Error("content is required");
        const run = await deps.runStore.readRun(runId);
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");
        const base = run.workspace_ref || process.cwd();
        const fullPath = join(base, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
        return { ok: true, path: fullPath, size: content.length };
      },
    },
  ];
}
