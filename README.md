# GPT-Codex Workspace

A bidirectional coordination system between **ChatGPT** and **Codex** for collaborative project development.

## Current Status

See `docs/current-status.md` for the latest operational state, known blockers, and cleanup notes.

Authentication is path-based: the URL suffix after `/mcp/` is extracted as the bearer token.
The default connector URL is `https://mcp.gptwork.cc.cd/mcp/dev-token` — no manual token setup required.
Future: different suffixes (e.g. `/mcp/workspace-x`) will allocate different workspace contexts.

- ChatGPT handles command, analysis, task creation, and mobile coordination.
- Codex handles implementation, testing, file edits, and verification.
- The backend MCP service owns authentication, workspaces, tasks, and audit.
- **GitHub Issues** can optionally replace the need for a public HTTPS reverse proxy.

## Architecture: Two Coordination Modes

### Mode 1: Direct MCP (works with HTTPS/LAN)

```
ChatGPT App (web/mobile)
    |  @GPTWork via MCP
    v
Backend MCP Server (port 8787)
    |
    +-- Hosted workspaces
    +-- SSH workspaces (remote servers)
    +-- Task queue, coordination requests
    ^
    |  @gpt-codex-workspace plugin
Codex Plugin
```

Requires the backend MCP endpoint to be reachable from ChatGPT (needs HTTPS or LAN).

### Mode 2: GitHub Issues (no reverse proxy needed)

```
ChatGPT                                        Codex
   |                                             |
   |  Creates GitHub Issue                       |
   |  with label gptwork-task                    |
   +--------> GitHub Repo <----------------------+
              Issues
   |                                             |
   |  Reads updated issue                        |
   |  (status, logs, results)                    |
   |                                             |
   |  Creates GitHub Issue          sync_from_   |
   |  comment as ChatGPT            github /     |
   |  response                     sync_github_  |
   |                             comments tools  |
   +---------+                                   |
              +----> Backend MCP (LAN only)
                       polls GitHub Issues,
                       syncs to tasks,
                       Codex executes,
                       writes results back

   ChatGPT also: list_chatgpt_requests,         Codex also: create_chatgpt_request,
                 answer_chatgpt_request                    list_chatgpt_requests,
                 (via MCP if reachable)                     get_chatgpt_request (via MCP)
```

In this mode, ChatGPT interacts with GitHub Issues directly. The backend periodically syncs GitHub Issues ↔ tasks. No public HTTPS MCP endpoint is needed — the backend only needs to be reachable by Codex (same LAN or SSH).

## Quick Start

### 1. Backend (on your server)

```bash
cd backend
GPTWORK_HOST=0.0.0.0 GPTWORK_TOKENS=dev-token,test GPTWORK_REQUIRE_AUTH=true node src/cli.mjs
```

Test it:
```bash
curl http://127.0.0.1:8787/health
```

### 2. Codex Plugin (install from marketplace)

```bash
codex plugin marketplace add 9018/gpt-codex-workspace --ref main
codex plugin marketplace upgrade
```

Enable `gpt-codex-workspace` in the Codex plugin UI. Set env vars:
```powershell
$env:GPTWORK_API_TOKEN="dev-token"
$env:GPTWORK_MCP_URL="http://10.0.1.103:8787/mcp"
```

### 3. ChatGPT App

**Via MCP (direct):** Add a connector/app in ChatGPT with:
```text
Connector URL: https://mcp.gptwork.cc.cd/mcp/dev-token
Auth: none / unauthenticated in ChatGPT UI
```

If a client can send custom headers, the older form also works: `https://mcp.gptwork.cc.cd/mcp` with `Authorization: Bearer dev-token`.

The LAN endpoint `http://10.0.1.103:8787/mcp` is for local verification and Codex-side fallback, not for ChatGPT cloud access.

**Via GitHub Issues (no reverse proxy):** See "GitHub Issues Coordination" below.

### 4. GitHub Issues Sync (optional, recommended for no-reverse-proxy)

On the backend:
```bash
export GPTWORK_GITHUB_REPO=your-org/your-repo
export GPTWORK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

## Workflow: ChatGPT Tries Direct First

When ChatGPT receives a user request, it follows this order:

1. **Try direct MCP tools first.** For simple queries and read operations (check status, read a file, list a directory, run a non-destructive shell command), ChatGPT calls the tools directly. This is fast and does not involve Codex.

2. **Fall back to create_goal if blocked.** If ChatGPT's safety policy blocks the direct call (common for write operations, shell execution, multi-step procedures) or the task is too complex for step-by-step tool calls, ChatGPT creates a shared goal:

   ```text
   create_goal({
     user_request: "...",
     goal_prompt: "...",
     mode: "builder",  // or "deploy" for deployment
     assign_to_codex: true
   })
   ```

3. **Codex executes.** Codex discovers the assigned goal via `list_goals`, loads context via `get_goal_context`, works through the steps, and reports back via `append_goal_message`.

What ChatGPT can usually do directly: read files, list directories, check service status, search files, list tasks/goals, health checks.

What triggers Goal → Codex: writing files, executing commands, deployment, multi-step modifications, any operation ChatGPT's safety policy blocks.

## Bidirectional Coordination

### ChatGPT → Codex

In ChatGPT, create a shared goal:

> @GPTWork Turn this into a Codex goal: fix the failing login test on the remote workspace, preserve this conversation context, and assign it to Codex.

ChatGPT should write a clear `goal_prompt` from the user's request, then call `create_goal` with `user_request`, `goal_prompt`, optional `context_summary`, recent `messages`, durable `memories`, `workspace_id`, `mode`, and `assign_to_codex: true`. The backend stores the goal, conversation, memory records, and creates a linked Codex task. Codex then calls `get_goal_context` before acting and writes progress back with `append_goal_message`.

Note: the older `create_task` → `assign_task_to_codex` path is blocked by ChatGPT's safety policy. Use `create_goal` with `assign_to_codex: true` instead, which is the only reliable ChatGPT → Codex channel.

For ordinary implementation or deployment tasks, default to `mode: "builder"`. Pass `mode: "deploy"` for Docker/service deployment.

### Codex → ChatGPT

Codex asks a question by creating a coordination request:

> Use GPTWork to ask ChatGPT to review this diff before I apply it.

Codex calls `create_chatgpt_request`. ChatGPT sees the open request and responds via `answer_chatgpt_request`.

### ChatGPT ↔ Codex via GitHub Issues (no reverse proxy)

1. **ChatGPT creates a task**: Creates a GitHub Issue with text describing the task.
2. **Backend polls**: Call `sync_from_github` tool. It imports new Issues as tasks.
3. **Codex executes**: Picks up the task, works on it, updates it.
4. **Backup syncs results**: Call `sync_to_github` to push status/logs back to the Issue.
5. **ChatGPT reads**: Views the updated Issue to see progress and results.
6. **Codex asks ChatGPT a question**: Creates a ChatGPT request via the MCP backend. If the backend syncs to GitHub Issues (auto-sync), a `[Question]` Issue is created.
7. **ChatGPT responds**: Writes a comment on the GitHub Issue.
8. **Codex reads the response**: Call `sync_github_comments` tool. It reads Issue comments and attaches them as `answer_chatgpt_request` responses.

## Tools (MCP Surface)

### Project & Workspace
- `list_projects` — List available projects
- `get_project` — Project detail
- `list_workspaces` — Workspaces in a project
- `get_workspace_info` — Workspace config
- `create_workspace` — Register a new hosted or SSH workspace
- `update_workspace` — Update workspace config
- `delete_workspace` — Remove workspace registration
- `test_workspace_connection` — Test SSH connectivity

### Shared Goals
- `create_goal` — Store a ChatGPT-written goal prompt, raw user request, conversation messages, durable memories, and optional assigned Codex task
- `list_goals` — List open or assigned shared goals for ChatGPT and Codex
- `get_goal_context` — Return the goal prompt, raw request, conversation, memories, and linked task before Codex starts work
- `append_goal_message` — Add ChatGPT/Codex/user progress or context to the shared conversation, optionally with a memory item

### Task Queue
> **Warning**: `create_task` + `assign_task_to_codex` is blocked by ChatGPT safety policy. Use `create_goal` with `assign_to_codex: true` as the primary ChatGPT → Codex channel.

- `create_task` — Create a task (used by Codex Worker internally; ChatGPT should use `create_goal` instead)
- `list_tasks` — List tasks, filter by status/assignee
- `get_task` — Full task detail with logs and artifacts
- `update_task_status` — Change task status
- `append_task_log` — Add a log entry
- `attach_task_artifact` — Attach a file/diff/result reference
- `assign_task_to_codex` — Hand off to Codex for execution; ordinary tasks default to `builder`, but this path is blocked by ChatGPT
- `list_codex_sessions_metadata` — Safely list `/home/a9017/.codex/sessions` file metadata only, without reading transcripts
- `create_codex_session_inventory_task` — Stream progress and return the completed safe readonly Codex session inventory result in the same call
- `run_assigned_codex_tasks` — Run approved built-in Codex handlers for already-assigned or interrupted tasks
- `complete_task` — Mark done with summary
- `request_human_review` — Mark as waiting for human input

### ChatGPT Coordination
- `create_chatgpt_request` — Codex asks ChatGPT a question
- `list_chatgpt_requests` — See requests needing ChatGPT attention
- `get_chatgpt_request` — Full request detail
- `answer_chatgpt_request` — ChatGPT provides response

### Workspace Files (hosted + SSH)
- `list_dir`, `stat_path`, `read_text_file`, `write_text_file`
- `upload_base64_file`, `download_file_base64`, `upload_from_url`
- `mkdir`, `delete_path`, `move_path`, `copy_path`
- `search_files`, `sha256_file`
- `create_zip_archive`, `extract_zip_archive`

### Execution
- `shell_exec` — Run a command in a workspace (requires `shell:exec` scope)
- Browser tools — Lightweight HTTP browser sessions

### GitHub Sync (no reverse proxy flow)
- `sync_to_github` — Push open tasks and requests to GitHub Issues
- `sync_from_github` — Import GitHub Issues as tasks + import comments as ChatGPT responses
- `sync_github_comments` — Check Issue comments for ChatGPT responses
- `github_status` — Show sync configuration

## Repository Layout

```
.agents/plugins/marketplace.json         - Codex marketplace manifest
plugins/gpt-codex-workspace/
  .codex-plugin/plugin.json              - Plugin manifest
  .mcp.json                               - MCP server config
  mcp/server.mjs                          - Local MCP proxy to backend
  skills/workspace-coordination/SKILL.md - Workflow skill for Codex
backend/
  src/cli.mjs                             - Server entry point
  src/gptwork-server.mjs                  - MCP handler + tools
  src/ssh-adapter.mjs                     - SSH + SFTP operations
  src/github-adapter.mjs                  - GitHub Issues sync
  src/state-store.mjs                     - JSON state persistence
  src/path-utils.mjs                      - Path safety utilities
  src/browser-http.mjs                    - Lightweight browser
  test/                                   - 19 tests
  systemd/gptwork-mcp.service            - systemd unit
  .env.example                            - Environment config
docs/
  architecture.md                         - Architecture document
  chatgpt-app-manifest.json              - ChatGPT App SDK manifest
```

## Deploy

```bash
cd backend
cp systemd/gptwork-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gptwork-mcp.service
```

## Tests

```bash
cd backend
node --test
# 19 tests, all pass
```

## License

MIT
