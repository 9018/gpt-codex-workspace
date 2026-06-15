# GPT-Codex Workspace Architecture

Date: 2026-06-15
Status: v1 operational
Default MCP endpoint: `https://mcp.gptwork.cc.cd/mcp/dev-token`

## Objective

Build a publicly distributable collaboration system that connects ChatGPT and Codex to the same project backend.

First version scope:

- Backend MCP with path-based token auth — the URL suffix after `/mcp/` is the bearer token.
- Team, project, and workspace management.
- Hosted workspace adapter.
- SSH workspace adapter.
- ChatGPT App / connector for project status, task creation, and task monitoring.
- Codex marketplace plugin for actual workspace work.
- Task queue where ChatGPT can create work and Codex can execute and report back.
- ChatGPT coordination requests where Codex can ask ChatGPT for analysis, decisions, or next-step instructions.
- Permissions, quotas, audit logs, and safety boundaries.

## Operating Model

```text
ChatGPT App = command, analysis, coordination, mobile access
Codex Plugin = implementation, testing, file edits, browser checks
Backend MCP = identity, project state, workspaces, SSH, task queue, audit
```

## High-Level Flow

```text
User on ChatGPT mobile
  -> GPTWork ChatGPT connector
  -> Backend MCP
  -> Task queue
  -> Codex plugin / worker
  -> Hosted or SSH workspace
  -> Results returned to backend
  -> ChatGPT summarizes status to user
```

## Backend Components

### Auth Service

Authentication is path-based. The URL suffix after `/mcp/` is used as the bearer token:

- `https://mcp.gptwork.cc.cd/mcp/dev-token` → token = `dev-token`
- `https://mcp.gptwork.cc.cd/mcp/workspace-a` → token = `workspace-a`

ChatGPT connectors that cannot send custom `Authorization` headers use these token-path URLs directly. Clients that support custom headers may still use `/mcp` with `Authorization: Bearer <token>`.

Tokens are validated against `GPTWORK_TOKENS` and resolved to a token context containing:

- user_id, user_name, team_id
- project_ids, workspace_ids
- scopes (project:read, workspace:write, shell:exec, etc.)

If `GPTWORK_REQUIRE_AUTH=false`, all requests run as the `anonymous` context.

### Project Service

Stores teams, projects, members, workspaces, default workspace, and recent activity.

### Workspace Service

Provides a uniform interface over hosted and SSH workspaces.

Required guarantees:

- File operations remain inside configured workspace root.
- Symlink traversal outside root is blocked.
- File, output, command, and browser limits are enforced.
- Every high-risk action is audited.

### SSH Workspace Adapter

Connects advanced users' remote servers to the project backend.

SSH credentials are stored only in the backend, encrypted at rest. ChatGPT and Codex plugins receive only API tokens and never receive SSH private keys.

Supported operations map to SFTP and SSH exec:

- list/read/write files
- upload/download
- move/copy/delete
- search
- sha256
- zip/unzip
- shell_exec when allowed

### Task Service

Tracks work created by ChatGPT, Codex, users, or API clients.

Statuses:

```text
draft
queued
assigned
planning
running
waiting_for_review
blocked
failed
completed
cancelled
```

### Audit Service

Records token use, project selection, workspace selection, file writes/deletes, shell commands, SSH connections, uploads, downloads, browser sessions, task assignments, and task completion.

## Token Scopes (Server-Configured)

Scope sets are assigned per token via `GPTWORK_TOKEN_CONTEXTS` on the server side, not by the end user.

Available scopes:

```text
project:read       project:admin
task:create        task:update      task:assign_codex
workspace:read     workspace:write
files:upload       files:download
shell:exec         ssh:use
browser:use        audit:read
```

The default `dev-token` has all scopes enabled. User-facing token scoping is not exposed as a self-service feature in v1.

## ChatGPT App Responsibilities

ChatGPT should optimize for command and coordination:

- Select project and workspace.
- View active tasks.
- Create a Codex task.
- Assign a task to Codex.
- Summarize task logs and verification results.
- Ask for user confirmation before high-risk actions.

ChatGPT should not directly expose raw shell execution as a default primary action.

## Codex Plugin Responsibilities

Codex should optimize for implementation:

- Read assigned tasks.
- Inspect project files.
- Edit workspace files.
- Run requested checks.
- Use browser tools for verification.
- Attach logs and artifacts.
- Update task status.
- Return a concise summary for ChatGPT/mobile review.

## Codex Plugin Distribution

The Codex marketplace entry lives at:

```text
.agents/plugins/marketplace.json
```

The plugin lives at:

```text
plugins/gpt-codex-workspace/
```

The plugin starts a local MCP proxy with:

```text
plugins/gpt-codex-workspace/.mcp.json
plugins/gpt-codex-workspace/mcp/server.mjs
```

The proxy reads:

```text
GPTWORK_API_TOKEN
GPTWORK_MCP_URL
```

`GPTWORK_MCP_URL` defaults to:

```text
https://mcp.gptwork.cc.cd/mcp
```

For local LAN development, set `GPTWORK_MCP_URL=http://10.0.1.103:8787/mcp`.

## ChatGPT App Distribution

ChatGPT connects directly to the backend MCP endpoint. Since ChatGPT's MCP connector does not always support custom HTTP headers, the token is embedded in the URL path:

```text
https://mcp.gptwork.cc.cd/mcp/dev-token
```

Connector metadata:

```text
Connector name: GPTWork
Description: Coordinate ChatGPT and Codex across project workspaces, task queues, and SSH environments.
Connector URL: https://mcp.gptwork.cc.cd/mcp/YOUR_TOKEN
```

When configuring the ChatGPT connector, set Auth mode to **none** / **unauthenticated**. The backend extracts the token from the URL path automatically.

## v1 MCP Tool Groups

Project tools:

```text
health_check
get_current_user
list_projects
get_project
list_workspaces
get_workspace_info
set_active_workspace
list_recent_activity
```

Shared goals tools:

```text
create_goal
list_goals
get_goal_context
append_goal_message
```

Task tools:

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
list_codex_sessions_metadata
create_codex_session_inventory_task
run_assigned_codex_tasks
create_chatgpt_request
list_chatgpt_requests
get_chatgpt_request
answer_chatgpt_request
```

Workspace tools:

```text
list_dir
stat_path
read_text_file
download_file_base64
write_text_file
upload_base64_file
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

Browser tools:

```text
browser_new_session
browser_goto
browser_current_state
browser_get_text
browser_get_html
browser_click
browser_fill
browser_press
browser_wait_for_selector
browser_scroll
browser_screenshot
browser_evaluate
```

## Public Release Checklist

Backend:

- Path-based token auth implemented.
- Project/workspace model implemented.
- Hosted workspace adapter implemented.
- SSH workspace adapter implemented.
- Task queue implemented.
- Audit logs implemented.
- Scope checks implemented.
- Limits implemented.

ChatGPT:

- Public endpoint works over HTTPS.
- Connector metadata is clear.
- Project and task flows tested.
- Mobile access tested after web connection.

Codex:

- Marketplace manifest exists.
- Plugin manifest exists.
- Local MCP proxy starts.
- Proxy forwards token and endpoint correctly.
- Proxy works with the default endpoint.
- Workspace coordination skill is discoverable.

## Open Questions

- Should public branding be GPTWork or GPT-Codex Workspace?
- Should `shell:exec` ever be exposed to ChatGPT in v1?
- Should the backend run its own Codex worker, or only coordinate user-owned Codex sessions?
- Should SSH workspaces be project-admin managed only, or can each user bring their own remote workspace?
