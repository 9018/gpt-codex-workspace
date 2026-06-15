---
name: workspace-coordination
description: Use when Codex is asked to execute work through GPTWork via a ChatGPT-created shared goal with goal_prompt, conversation memory, and append_goal_message progress reporting.
---

# GPTWork Workspace Coordination

Use this skill when Codex is asked to work through GPTWork via a ChatGPT-created shared goal (create_goal with assign_to_codex=true).

## Goal

Codex acts as the implementation and verification worker. The backend MCP service is the source of truth for projects, workspaces, shared goals, conversation memory, task state, logs, artifacts, and audit history.

## How Work Reaches Codex

ChatGPT tries direct MCP tool calls first (read_file, shell_exec for simple queries). If ChatGPT cannot execute directly due to safety policy, write operations, or multi-step complexity, it falls back to create_goal with assign_to_codex=true. That is the only reliable ChatGPT to Codex channel. The old create_task to assign_task_to_codex path is blocked by ChatGPT safety policy and not used.

## Workflow

1. **Discover assigned goals.** Call `list_goals({ assignee: "codex", status: "assigned" })` to find open work. If a specific goal_id is referenced, use that directly.

2. **Load context.** Call `get_goal_context({ goal_id })` to get the goal prompt, raw user request, conversation messages, memories, linked task, and workspace.

3. **Report start.** Call `append_goal_message({ goal_id, role: "assistant", content: "Starting work: ..." })`.

4. **Inspect.** List relevant files, read only what is needed, use search before broad reads.

5. **Plan.** Keep changes scoped to the goal prompt. Prefer existing conventions. Note risky operations.

6. **Implement.** Use workspace file tools for edits. Use SSH-backed tools only through GPTWork MCP. Do not bypass workspace roots.

7. **Verify.** Run requested checks. If checks cannot run, record the exact blocker.

8. **Complete or flag blocker.**
   - Success: `append_goal_message` with final summary, then `complete_task` on the linked task.
   - Blocked: `append_goal_message` explaining what is needed (user action, credentials, etc.).

## Safety

- Treat `shell_exec` as high risk.
- Avoid destructive commands unless the task explicitly requires them and the token has permission.
- Never expose SSH private keys, API tokens, or secrets in task logs.
- Keep all file operations inside the selected workspace root.
- Prefer small, reviewable changes.
