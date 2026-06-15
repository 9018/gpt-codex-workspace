---
name: workspace-coordination
description: Use when Codex is asked to execute work through GPTWork encoded/shared goals with goal files, conversation memory, and append_goal_message progress reporting.
---

# GPTWork Workspace Coordination

Use this skill when Codex receives work from GPTWork. ChatGPT normally creates an encoded goal with `create_encoded_goal`; compatibility tasks are automatically linked to a goal by the backend.

## Goal

Codex is the implementation and verification worker. GPTWork backend is the source of truth for projects, workspaces, goals, tasks, conversation memory, logs, artifacts, and result files.

## How Work Reaches Codex

Primary path:

```text
ChatGPT preview_text + payload_base64
  -> create_encoded_goal(assign_to_codex=true)
  -> backend decodes payload
  -> backend writes .gptwork/goals/<goal_id>/ files
  -> backend creates/links an assigned task
  -> Codex executes the readable goal
```

Compatibility paths still exist:

- `create_goal` creates a readable shared goal.
- `create_task` creates a linked goal.
- `assign_task_to_codex` links old tasks to a goal before execution.

## Workflow

1. Discover assigned goals with `list_goals({ assignee: "codex", status: "assigned" })`, or use a referenced `goal_id` / `task_id`.
2. Load context with `get_goal_context({ goal_id })` or `get_goal_context({ task_id })`.
3. Read the workspace files listed in `workspace_files`:
   - `.gptwork/goals/<goal_id>/goal.md`
   - `.gptwork/goals/<goal_id>/context.json`
   - `.gptwork/goals/<goal_id>/transcript.md`
4. Report start with `append_goal_message({ goal_id, role: "codex", content: "Starting work..." })`.
5. Execute `goal.md` in the selected workspace. Keep changes scoped to the goal.
6. Use attachment bundles from `.gptwork/goals/<goal_id>/attachments/` when present.
7. Verify with the checks requested in the goal.
8. Write final output to `.gptwork/goals/<goal_id>/result.md`.
9. Append final progress with `append_goal_message`, including a concise summary and blockers if any.
10. Complete the linked task when the work is complete.

## Worker Prompt Contract

When GPTWork worker starts Codex automatically, it should run:

```bash
codex exec --yolo --skip-git-repo-check < promptFile
```

The prompt must include:

```text
You are executing a GPTWork encoded/shared goal.
Read goal.md, context.json, and transcript.md before acting.
Follow goal.md exactly.
Write result.md.
Report progress/results with append_goal_message.
```

## Operational Notes

- `mode: builder` is the default for implementation.
- `mode: deploy` is for Docker/service deployment and health checks.
- `mode: admin` is for maintenance.
- `readonly` is reserved for the dedicated Codex session inventory task.
- Zip bundles are transported as base64, then stored and extracted under the goal attachments directory.
- Do not expose private keys, API tokens, cookies, or unrelated session contents in logs.
