/**
 * project-command-tools.mjs — Command execution tools within the worktree.
 *
 * @module project-command-tools
 */

/**
 * Create command tools.
 *
 * @param {object} deps
 * @returns {object[]} Tool definitions
 */
export function createProjectCommandTools(deps) {
  return [
    {
      name: "project_run_command",
      description: "Run a shell command within the run's worktree directory.",
      handler: async ({ runId, command } = {}) => {
        if (!command) throw new Error("command is required");
        const run = await deps.runStore.readRun(runId);
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const execFileAsync = promisify(execFile);
        const base = run.workspace_ref || process.cwd();
        try {
          const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], { cwd: base, timeout: 60000, maxBuffer: 1024 * 1024 });
          return { ok: true, stdout: stdout || "", stderr: stderr || "", exit_code: 0 };
        } catch (err) {
          return { ok: false, stdout: err.stdout || "", stderr: err.stderr || err.message, exit_code: err.code || -1 };
        }
      },
    },
  ];
}
