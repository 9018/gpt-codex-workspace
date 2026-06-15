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

## Workflow: Encoded Goals For Codex Work

When ChatGPT receives a user request, it follows this order:

1. **Try direct MCP tools for simple reads.** For simple queries and read operations (check status, read a file, list a directory, health check), ChatGPT may call tools directly.

2. **Use `create_encoded_goal` for execution work.** For implementation, deployment, maintenance, file changes, multi-step work, or anything Codex should execute, ChatGPT writes a readable preview, base64-encodes the matching JSON payload, and calls:

   ```text
   create_encoded_goal({
     preview_text: "readable summary shown to the user",
     payload_base64: "base64(JSON.stringify(payload))",
     assign_to_codex: true,
     wait_ms: 90000
   })
   ```

3. **Backend writes readable goal files.** The backend decodes base64, stores `goal.md`, `context.json`, `transcript.md`, `payload.json`, `payload.base64`, and creates/links a task. The public tool response only shows the concise files (`dir`, `goal_md`, `result_md`); debug files are returned as `internal_files` or through `get_goal_context`.

4. **Codex executes.** Codex discovers the assigned goal via `list_goals`, loads context via `get_goal_context`, reads the workspace goal files, writes `result.md`, and reports back via `append_goal_message`. When `wait_ms` is provided, ChatGPT receives an `execution` snapshot in the same tool result and should show that instead of asking the user to poll the task id.

What ChatGPT can usually do directly: read files, list directories, check service status, search files, list tasks/goals, health checks.

Base64 is transport encoding only. It is not used to hide intent: the user sees the preview, the backend stores readable files, and Codex reads readable instructions.

## Bidirectional Coordination

### ChatGPT → Codex

In ChatGPT, create an encoded shared goal:

> @GPTWork Turn this into a Codex goal: fix the failing login test on the remote workspace, preserve this conversation context, and assign it to Codex.

ChatGPT should write a clear `preview_text` from the user's request, then build a payload containing `user_request`, `goal_prompt`, `context_summary`, `messages`, `memories`, `workspace_id`, and `mode`. It sends the payload as `payload_base64` to `create_encoded_goal(assign_to_codex=true, wait_ms=90000)`. The backend stores readable goal files, conversation records, memory records, and creates a linked Codex task. Codex then calls `get_goal_context`, reads the goal files, and writes progress back with `append_goal_message`.

Compatibility remains: `create_goal` still works, and `create_task` + `assign_task_to_codex` automatically creates or links a goal. The recommended ChatGPT path for complex execution is `create_encoded_goal`.

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
- `create_encoded_goal` — Decode a base64 JSON payload, store readable goal/context/transcript files, optionally assign Codex, and return an execution snapshot when `wait_ms` is set
- `create_goal` — Store a ChatGPT-written goal prompt, raw user request, conversation messages, durable memories, and optional assigned Codex task
- `list_goals` — List open or assigned shared goals for ChatGPT and Codex
- `get_goal_context` — Return the goal prompt, raw request, conversation, memories, and linked task before Codex starts work
- `append_goal_message` — Add ChatGPT/Codex/user progress or context to the shared conversation, optionally with a memory item

### Task Queue
- `create_task` — Create a task; ordinary tasks automatically receive a linked goal, and encoded envelopes in `description` are decoded
- `list_tasks` — List tasks, filter by status/assignee
- `get_task` — Full task detail with logs and artifacts
- `update_task_status` — Change task status
- `append_task_log` — Add a log entry
- `attach_task_artifact` — Attach a file/diff/result reference
- `assign_task_to_codex` — Hand off to Codex for execution; old tasks are linked to goals before execution
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
- `upload_base64_file`, `download_file_base64`, `upload_bundle_base64`, `download_bundle_base64`, `upload_from_url`
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
