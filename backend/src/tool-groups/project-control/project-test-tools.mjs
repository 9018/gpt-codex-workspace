/**
 * project-test-tools.mjs — Test execution tools for project control.
 *
 * @module project-test-tools
 */

export function createProjectTestTools(deps) {
  return [
    {
      name: "project_run_tests",
      description: "Run test commands within the run's worktree.",
      handler: async ({ runId, command } = {}) => {
        if (!command) throw new Error("test command is required");
        const run = await deps.runStore.readRun(runId);
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const execFileAsync = promisify(execFile);
        const base = run.workspace_ref || process.cwd();
        try {
          const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], { cwd: base, timeout: 300000, maxBuffer: 5 * 1024 * 1024 });
          return { ok: true, stdout: stdout || "", stderr: stderr || "", exit_code: 0 };
        } catch (err) {
          return { ok: false, stdout: err.stdout || "", stderr: err.stderr || err.message, exit_code: err.code || -1 };
        }
      },
    },
  ];
}
