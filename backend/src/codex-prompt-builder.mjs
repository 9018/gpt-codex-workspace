/**
 * Codex execution prompt builder.
 *
 * Generates the exact prompt that Codex receives when executing a task.
 * The prompt is intentionally entry-first: Codex should read codex.entry.md
 * before any larger goal/state file. Larger files remain available as explicit
 * deep-lookup references.
 */

const RESULT_SCHEMA_HINT = `Write result.json with these top-level fields when applicable:
{
  "status": "completed|failed|timed_out",
  "summary": "one-line summary",
  "changed_files": [],
  "tests": "commands and pass/fail evidence or none",
  "commit": "sha or none",
  "remote_head": "sha or none",
  "warnings": [],
  "followups": [],
  "verification": { "commands": [], "passed": true }
}`;

/**
 * Build the full Codex execution prompt string.
 *
 * @param {object} options
 * @param {object}  options.task
 * @param {object}  [options.goal]
 * @param {object}  [options.workspaceFiles]
 * @param {string}  options.workspaceRoot
 * @param {string}  [options.defaultRepoPath]
 * @returns {{ fullPrompt: string, promptBytes: number }}
 */
export function buildCodexPrompt({
  task, goal, workspaceFiles, workspaceRoot, defaultRepoPath,
  executionRepoPath,
  goalStateDir,
  resultJsonPath,
  resultMdPath,
  canonicalRepoPath,
  taskWorktreePath,
} = {}) {
  const separator = "=".repeat(60);
  const taskId = task?.id || "unknown";
  const _executionRepoPath = executionRepoPath || defaultRepoPath || workspaceRoot;
  const _goalStateDir = goalStateDir || (workspaceRoot + "/.gptwork/goals/" + (goal ? goal.id : taskId));
  const _resultJsonPath = resultJsonPath || (_goalStateDir + "/result.json");
  const _resultMdPath = resultMdPath || (_goalStateDir + "/result.md");
  const _canonicalRepoPath = canonicalRepoPath || defaultRepoPath || "(not configured)";
  const worktreeLine = taskWorktreePath ? `- **Task worktree path**: ${taskWorktreePath}` : '';

  let goalContextBlock = "";
  if (goal) {
    const files = workspaceFiles || {};
    const dir = files.dir || _goalStateDir;
    const entryRef = files.codex_entry_md || `${dir}/codex.entry.md`;
    const bundleRef = files.context_bundle_md || `${dir}/context.bundle.md`;
    const contextRef = files.context_json || `${dir}/context.json`;
    const goalRef = files.goal_md || `${dir}/goal.md`;
    const transcriptRef = files.transcript_md || `${dir}/transcript.md`;

    goalContextBlock = [
      `Start by reading only this bounded entrypoint:`,
      `- ${entryRef}`,
      ``,
      `Context lookup policy:`,
      `- Use codex.entry.md plus context.bundle.md as the default execution context when the bundle exists.`,
      `- Prefer ${bundleRef} for supporting context when present.`,
      `- Do not read context.json, goal.md, or transcript.md wholesale by default; they are explicit deep-lookup files.`,
      `- Use ${contextRef} only for metadata lookup; do not read it wholesale before acting.`,
      `- Use ${goalRef} only for explicit deep lookup when the entry and bundle are insufficient.`,
      `- Use ${transcriptRef} only for explicit conversation lookup when required.`,
      `- Do not read payload files unless debugging payload encoding or missing fields.`,
      `- Project context files under the canonical repo are optional lookups.`,
      ``,
      `Write final Markdown results to ${files.result_md || _resultMdPath}.`,
    ].filter(Boolean).join("\n");
  }

  const fullPrompt = `# Task: ${task?.title || taskId}

## Execution Path Contract
- **Edit code only under**: ${_executionRepoPath}
- **Read goal/state files from**: ${_goalStateDir}
- **Write result.json exactly to**: ${_resultJsonPath}
- **Write result.md to**: ${_resultMdPath}
- **Canonical repository**: ${_canonicalRepoPath}
${worktreeLine}

${task?.description || ""}

${goal ? `# GPTWork Goal Context

You are executing a GPTWork encoded/shared goal.

${goalContextBlock}

${RESULT_SCHEMA_HINT}

2. Stdout structured report (legacy, still read):
STATUS=<completed|failed|timed_out>
SUMMARY=<one line>
CHANGED_FILES=<comma separated or none>
TESTS=<commands and pass/fail or none>
COMMIT=<sha or none>
REMOTE_HEAD=<sha or none>

GPTWork will read result.json first when available, falling back to the stdout report.` : ""}
${separator}
${separator}
## Safe Restart Rule
If you need to restart GPTWork (the service running this worker), you MUST NOT run the restart command directly inline for a self-restart. Doing so can kill the worker before the task can complete. Use schedule_service_restart to perform a safe two-phase restart.
Instead:
1. Write result.json with your final result first.
2. Call schedule_service_restart with your task_id, expected_commit, and optional expected_remote_head.
3. The tool safely writes a pending restart marker and schedules the restart detached from the current request.

${separator}
Execute the EXACT steps above, in order. Do not skip, substitute, or improvise.
All code changes must be made within the execution repo path.
Read codex.entry.md first; deep-read larger goal/state files only when needed.
The canonical repository is at ${_canonicalRepoPath}.
Project context files (.gptwork/project.md, .gptwork/project.env) live under the canonical repo.

Write result.json to ${_resultJsonPath}

After completing ALL steps, also output the structured report to stdout (legacy format):
STATUS=<completed|failed|timed_out>
SUMMARY=<one line>
CHANGED_FILES=<comma separated or none>
TESTS=<commands and pass/fail or none>
COMMIT=<sha or none>
REMOTE_HEAD=<sha or none>
${separator}`;

  const promptBytes = Buffer.byteLength(fullPrompt, "utf8");
  return { fullPrompt, promptBytes };
}
