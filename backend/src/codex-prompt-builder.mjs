/**
 * Codex execution prompt builder.
 *
 * Generates the exact prompt that Codex receives when executing a task.
 * Used by processGeneralTask and preview_codex_context to ensure consistent
 * prompt size reporting.
 *
 * Extracted from the inline prompt construction in processGeneralTask (gptwork-server.mjs)
 * as a preparatory refactor for later context slimming.
 *
 * P0.5: Includes context.bundle.md reference when workspaceFiles provides it.
 */

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the full Codex execution prompt string.
 *
 * @param {object} options
 * @param {object}  options.task          - Task object ({ id, title, description, ... }).
 * @param {object}  [options.goal]        - Linked goal object (optional). When present
 *                                          workspaceFiles must also be provided.
 * @param {object}  [options.workspaceFiles] - Workspace files from goalWorkspaceFiles(goal).
 *                                             Required when goal is provided.
 * @param {string}  options.workspaceRoot - Absolute workspace root path.
 * @param {string}  [options.defaultRepoPath] - Canonical repo path (optional).
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
  // Resolve paths with fallbacks for backward compatibility
  const _executionRepoPath = executionRepoPath || defaultRepoPath || workspaceRoot;
  const _goalStateDir = goalStateDir || (workspaceRoot + "/.gptwork/goals/" + (goal ? goal.id : task?.id || "unknown"));
  const _resultJsonPath = resultJsonPath || (_goalStateDir + "/result.json");
  const _resultMdPath = resultMdPath || (_goalStateDir + "/result.md");
  const _canonicalRepoPath = canonicalRepoPath || defaultRepoPath || "(not configured)";
  const worktreeLine = taskWorktreePath ? `- **Task worktree path**: ${taskWorktreePath}` : '';

  // Build workspace file references section
  let goalContextBlock = "";
  if (goal) {
    const files = workspaceFiles || {};
    const bundleRef = files.context_bundle_md
      ? `- ${files.context_bundle_md} (if present — preferred over full transcript for initial context)`
      : null;

    goalContextBlock = [
      `Read these files before acting:`,
      `- ${files.goal_md}`,
      `- ${files.context_json}`,
      bundleRef,
      `- .gptwork/project.md (if present — project-level context)`,
      `- .gptwork/project.env (if present — project-level env vars, do not commit or print secrets)`,
      ``,
      `Follow ${files.goal_md} exactly.`,
      `Use ${files.context_json} only for metadata you need.`,
      `If a context bundle exists at ${files.context_bundle_md || `${files.dir}/context.bundle.md`}, prefer it over the full transcript for initial context.`,
      `Do not dump or re-read ${files.transcript_md} unless the goal explicitly requires prior conversation details or the context bundle is insufficient.`,
    ].filter(Boolean).join("\n");
  }

  const fullPrompt = `# Task: ${task.title}

## Execution Path Contract
- **Edit code only under**: ${_executionRepoPath}
- **Read goal/state files from**: ${_goalStateDir}
- **Write result.json exactly to**: ${_resultJsonPath}
- **Write result.md to**: ${_resultMdPath}
- **Canonical repository**: ${_canonicalRepoPath}
${worktreeLine}

${task.description || ""}

${goal ? `# GPTWork Goal Context

You are executing a GPTWork encoded/shared goal.

${goalContextBlock}

Write final results to ${workspaceFiles.result_md}.
When complete, write a concise structured report in TWO formats:

    1. result.json — write to ${_resultJsonPath} with this exact structure:
   {
     "status": "completed|failed|timed_out",
     "summary": "one-line summary",
     "changed_files": ["path/to/file1.js", "path/to/file2.js"],
     "tests": "npm test: passed 15/15",
     "commit": "sha256",
     "remote_head": "sha256",
     "warnings": ["warning text"],
     "followups": ["follow-up item"],
     "reviewer_decision": { "status": "accepted|accepted_with_followups|needs_fix", "passed": true },
     "acceptance_findings": [],
     "next_tasks": [],
     "repair_proposal": null,
     "subagents_used": true,
     "gpt_questions_used": 0,
     "decision_log": [],
     "subagents": [
       { "role": "analyst", "status": "completed", "summary": "..." },
       { "role": "architect", "status": "completed", "summary": "..." },
       { "role": "implementer", "status": "completed", "summary": "..." }
     ],
     "verification": {
       "commands": [],
       "passed": true
     },
     "escalation": {
       "needed": false,
       "reason": "All decisions were technical and reversible."
     }
   }

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
If you need to restart GPTWork (the service running this worker), you MUST NOT run the restart command directly inline for a self-restart. Doing so will kill the worker before the task can complete, causing the task to get stuck. Use schedule_service_restart to perform a safe two-phase restart.
Instead:
1. Write result.json with your final result first.
2. Call schedule_service_restart with your task_id, expected_commit (the HEAD you committed/pushed), and optional expected_remote_head.
3. The tool safely writes a pending restart marker and schedules the restart detached from the current request.
4. The actual service restart happens ~2 seconds later, giving time for the current response to return cleanly.
5. After restart, GPTWork detects the marker, verifies the running commit equals the expected_commit, and finalizes your task.


${separator}
Execute the EXACT steps above, in order. Do not skip, substitute, or improvise.
All code changes must be made within the execution repo path.
Read goal/state files from the specified goal state directory.
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
