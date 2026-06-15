# GPT-Codex Workspace Architecture

Date: 2026-06-15
Status: v2 encoded goal workflow
Default MCP endpoint: `https://mcp.gptwork.cc.cd/mcp/dev-token`

## Objective

GPTWork connects ChatGPT and Codex to one backend MCP service.

- ChatGPT writes user-facing plans and creates encoded goals.
- Codex executes decoded readable goals in hosted or SSH workspaces.
- The backend stores identity, workspaces, goals, tasks, context files, bundles, logs, and results.
- Codex plugin distribution comes from `9018/gpt-codex-workspace`.

## Operating Model

```text
ChatGPT App = command, preview, encoded goal creation, status review
Codex Plugin = implementation, deployment, testing, verification
Backend MCP = auth, project state, workspace IO, goal/task queue, audit
```

## High-Level Flow

```text
User request
  -> ChatGPT readable preview
  -> payload JSON
  -> base64 payload
  -> create_encoded_goal(assign_to_codex=true)
  -> Backend decodes and writes .gptwork/goals/<goal_id>/ files
  -> Backend creates/links task
  -> Codex reads goal.md/context.json/transcript.md
  -> Codex executes and writes result.md
  -> append_goal_message reports progress/results
```

## Auth Service

Authentication is path-based. The URL suffix after `/mcp/` is used as the bearer token:

- `https://mcp.gptwork.cc.cd/mcp/dev-token` -> token = `dev-token`
- `https://mcp.gptwork.cc.cd/mcp/workspace-a` -> token = `workspace-a`

Clients that support custom headers may still use `/mcp` with `Authorization: Bearer <token>`. ChatGPT should normally use the path-token URL and auth mode `none`.

## Workspace Service

GPTWork supports hosted and SSH workspaces.

- Hosted workspace root is configured with `GPTWORK_WORKSPACE_ROOT`.
- SSH workspaces prefer key authentication.
- Hosts outside `10.0.0.0/8` use default SOCKS proxy `10.0.1.105:20177` unless overridden.
- File operations stay inside the selected workspace root.

## Encoded Goal Service

Primary tool:

```text
create_encoded_goal
```

Input:

```json
{
  "preview_text": "readable explanation shown to the user",
  "payload_base64": "base64(JSON.stringify(payload))",
  "assign_to_codex": true
}
```

Decoded payload:

```json
{
  "user_request": "original user request",
  "goal_prompt": "complete readable Codex instruction",
  "context_summary": "conversation summary",
  "mode": "builder | deploy | admin",
  "workspace_id": "hosted-default",
  "messages": [],
  "memories": [],
  "attachments": []
}
```

Workspace files:

```text
.gptwork/goals/<goal_id>/goal.md
.gptwork/goals/<goal_id>/context.json
.gptwork/goals/<goal_id>/transcript.md
.gptwork/goals/<goal_id>/payload.json
.gptwork/goals/<goal_id>/payload.base64
.gptwork/goals/<goal_id>/result.md
.gptwork/goals/<goal_id>/attachments/
```

Base64 is transport encoding only. The backend and Codex always keep readable decoded files.

## Compatibility Task Service

`create_task` and `assign_task_to_codex` remain available.

- `create_task` with a normal description automatically creates a linked goal.
- `create_task` with a `gptwork.encoded_goal.v1` envelope decodes the payload and links a readable goal.
- `assign_task_to_codex` links old tasks to a goal before Codex execution.
- Ordinary readonly tasks are promoted to `builder`; only the dedicated session inventory task remains readonly.

## Bundles

Instruction payloads use `JSON -> base64`.

Files use `zip -> base64`:

- `upload_bundle_base64`
- `download_bundle_base64`
- `create_zip_archive`
- `extract_zip_archive`

Bundles referenced by a goal are stored under `.gptwork/goals/<goal_id>/attachments/`.

## Codex Worker

Default command:

```bash
codex exec --yolo --skip-git-repo-check < promptFile
```

Override:

```bash
GPTWORK_CODEX_EXEC_ARGS="--yolo --skip-git-repo-check"
```

Worker prompts include the goal file paths and require Codex to read `goal.md`, `context.json`, and `transcript.md` before acting.

## Tool Groups

Shared goals:

```text
create_encoded_goal
create_goal
list_goals
get_goal_context
append_goal_message
```

Tasks:

```text
create_task
list_tasks
get_task
update_task_status
append_task_log
attach_task_artifact
assign_task_to_codex
complete_task
request_human_review
run_assigned_codex_tasks
```

Workspace files:

```text
list_dir
stat_path
read_text_file
download_file_base64
write_text_file
upload_base64_file
upload_bundle_base64
download_bundle_base64
upload_from_url
mkdir
delete_path
move_path
copy_path
search_files
sha256_file
create_zip_archive
extract_zip_archive
shell_exec
```

Coordination:

```text
create_chatgpt_request
list_chatgpt_requests
get_chatgpt_request
answer_chatgpt_request
```

GitHub sync:

```text
sync_to_github
sync_from_github
sync_github_comments
github_status
```

## Distribution

Codex plugin marketplace source:

```text
9018/gpt-codex-workspace
```

Plugin files:

```text
plugins/gpt-codex-workspace/.mcp.json
plugins/gpt-codex-workspace/mcp/server.mjs
plugins/gpt-codex-workspace/skills/workspace-coordination/SKILL.md
```

Required plugin env:

```text
GPTWORK_API_TOKEN=dev-token
GPTWORK_MCP_URL=http://10.0.1.103:8787/mcp
```

ChatGPT connector:

```text
Connector URL: https://mcp.gptwork.cc.cd/mcp/dev-token
Auth mode: none / unauthenticated
```
