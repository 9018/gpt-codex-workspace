# GPT-Codex Workspace

[中文说明](README.zh-CN.md) | English


A bidirectional coordination system between **ChatGPT** and **Codex** for collaborative project development.

## Current Status

See `docs/current-status.md` for the latest operational state and `docs/goal-queue.md` for the goal queue execution, known blockers, and cleanup notes.
Queue tools (`enqueue_goal`, `list_goal_queue`, `start_next_queued_goal`, etc.) are now fully exposed in standard/codex/full modes.
See `docs/widget-card.md` for Apps SDK card v2 rendering.

## Product Acceptance / Verification

See `docs/e2e-acceptance.md` for the full E2E product acceptance report covering runtime diagnostics, tool mode security boundaries, goal→task→result pipeline, agent/handoff lifecycle, event log, GitHub/Bark integrations, and the Apps SDK widget resource.

```bash
cd backend && npm run test:e2e-acceptance
```


## 5-Minute Quick Start

```bash
cd backend
npm install
npm link
gptwork setup
gptwork settings set GPTWORK_TOOL_MODE standard
gptwork start
```

In another shell:

  ```bash
gptwork doctor --local
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
  ```

For ChatGPT, use `open_project_context` first. It returns the current repo, worker, queue, scripts, recent tasks/goals, bounded file tree, and recommended next tools without exposing the full debug tool surface. The default MCP tool mode is `standard`; set `GPTWORK_TOOL_MODE=full` only for operator/debug sessions.

Authentication is path-based: the URL suffix after `/mcp/` is extracted as the bearer token.
The default connector URL is `https://mcp.gptwork.cc.cd/mcp/dev-token` — no manual token setup required.
Future: different suffixes (e.g. `/mcp/workspace-x`) will allocate different workspace contexts.

- ChatGPT handles command, analysis, task creation, and mobile coordination.
For a detailed setup and connection guide, see [docs/setup-connect.md](docs/setup-connect.md).

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

The CLI-first path above is the recommended path for new users. The lower-level systemd deployment remains available for long-running production hosts.

### Recommended Deployment

The canonical repo is at `/home/a9017/mcp/workspace/gpt-codex-workspace`, with global runtime env at `/home/a9017/mcp/workspace/.gptwork/runtime.env` and hosted-default workspace root at `/home/a9017/mcp/workspace`.

### 1. Backend (production)

```bash
cd /home/a9017/mcp/workspace/gpt-codex-workspace/backend
cp systemd/gptwork-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gptwork-mcp.service
```

The `.gptwork/runtime.env` file in the workspace root configures all GPTWORK_* variables.
Verify with:

```bash
curl http://127.0.0.1:8787/health
```

### 2. Codex Plugin

```bash
codex plugin marketplace add 9018/gpt-codex-workspace --ref main
codex plugin marketplace upgrade
```

Enable `gpt-codex-workspace` in the Codex plugin UI. Set env vars:
```bash
export GPTWORK_API_TOKEN="dev-token"
export GPTWORK_MCP_URL="http://10.0.1.103:8787/mcp"
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

1. **ChatGPT creates a task**: Creates a GitHub Issue with text describing the task. Titles like `[GPTWork Task] ...` are auto-labeled by `.github/workflows/main.yml`.
2. **Backend polls**: The Codex worker automatically imports matching GitHub Issues each tick; `sync_from_github` can still be called manually.
3. **Codex executes**: Picks up the task, works on it, updates it.
4. **Backup syncs results**: Call `sync_to_github` to push status/logs back to the Issue.
5. **ChatGPT reads**: Views the updated Issue to see progress and results.
6. **Codex asks ChatGPT a question**: Creates a ChatGPT request via the MCP backend. If the backend syncs to GitHub Issues (auto-sync), a `[Question]` Issue is created.
7. **ChatGPT responds**: Writes a comment on the GitHub Issue.
8. **Codex reads the response**: Call `sync_github_comments` tool. It reads Issue comments and attaches them as `answer_chatgpt_request` responses.


## GitHub Actions Dispatch Bridge

GitHub Actions provides an explicit trigger path for dispatching task payloads to the GPTWork backend, complementing the worker polling and direct MCP modes.

The bridge is defined in `.github/workflows/gptwork-dispatch.yml`. The entrypoint script is `backend/scripts/github-actions-dispatch.mjs`.

### Triggers

| Trigger | Details |
|---|---|
| `push` to `main` with `.gptwork/goal-inbox/**` | Payload files under the goal-inbox directory are discovered on push |
| `issues` (opened, edited, labeled) | Only issues with the `gptwork-task` label are processed |
| `workflow_dispatch` (manual) | Accepts `issue_number` or `payload_path` input for explicit dispatch |

### Flow

```
Push to main (.gptwork/goal-inbox/**)         Issue (opened/edited/labeled)
  or workflow_dispatch                           with gptwork-task label
        |                                               |
        v                                               v
  GitHub Actions runner                                  |
  runs github-actions-dispatch.mjs                       |
        |                                               |
        v                                               v
  Reads event payload, identifies task context
  Calls `create_goal` on GPTWork MCP endpoint
  Status reported via Issue comment and Actions summary
```

### Processing Rules

- **Issue processing:** Requires the `gptwork-task` label. Issues without this label are skipped. The issue body is dispatched as `create_goal` with `assign_to_codex: true`. A comment is posted to the issue confirming dispatch or reporting errors.
- **Push payload discovery:** Files under `.gptwork/goal-inbox/` are detected on push to `main`. The script prefers `.zip.b64` files (extracts `goal.md` and `payload.json`), falls back to `-task.md` markdown files with YAML front-matter, then to `-restore.md` restore descriptors.
- **Manual dispatch:** Use `workflow_dispatch` with `issue_number` to dispatch an existing issue's body as a goal, or `payload_path` to point to a specific inbox payload file relative to the workspace root.
- **Environment and secrets:** All configuration values (`GPTWORK_MCP_URL`, `GPTWORK_MCP_TOKEN`, `GITHUB_TOKEN`) are injected through workflow secrets. Never hardcoded in the script.
- **Status reporting:** Progress and results are written to the Actions step summary (`GITHUB_STEP_SUMMARY`) and, when triggered by an issue or workflow_dispatch with an issue_number, posted as issue comments.

### Compatibility

The dispatch bridge is **additive**. It does not replace:

- The existing Codex worker (polls for assigned tasks and executes them)
- The GitHub Issues sync flow (`sync_to_github`, `sync_from_github`, `sync_github_comments`)
- Direct MCP coordination through `create_encoded_goal`

The bridge provides an explicit, event-driven trigger so that pushes to the goal inbox or labeled issues can kick off execution without waiting for the next worker poll cycle or requiring ChatGPT to be online.

### File Layout

```
.github/workflows/gptwork-dispatch.yml       - Workflow definition
backend/scripts/github-actions-dispatch.mjs  - Dispatch script entrypoint
.gptwork/goal-inbox/                         - Payload files discovered on push
backend/test/fixtures/github-dispatch/       - Test fixtures for dispatch
```

## Compact Visual Cards and Low-Noise Output

GPTWork/Codex tool responses should prefer compact visual-card summaries over raw terminal-style output. This reduces chat noise and surfaces the information users need most without requiring them to parse raw logs and diffs.

### Principle

- Tool results display key information in a structured card format with status indicators, key-value pairs, and actionable summaries.
- Raw output (git logs, tree listings, terminal output, diffs, large context blocks) is folded, truncated, or summarized by default in conversational interfaces.
- Machine-readable `structuredContent` payloads remain compatible and unchanged for programmatic clients.
- Full raw details remain accessible through artifact paths, result files, or explicit follow-up tools.

### Tools and Their Card Focus

| Tool | Card focus |
|---|---|
| `create_encoded_goal` | Goal ID, task ID, status, result path, Codex assignment confirmation |
| `runtime_status` | Service status, running commit, worker state, GitHub sync, Bark status |
| `gptwork_doctor` | Red/yellow/green diagnostics with suggested next actions |
| `get_task` | Task status, log summary, changed files, tests, commit |
| `preview_codex_context` | Context sources, size metrics, warnings |
| `github_status` | Repository, sync enabled, known/pending issue state |

### Structured Content

- All card-style responses should include a `structuredContent` field when the MCP protocol supports it, preserving machine readability.
- Clients that parse `structuredContent` can extract exact values (status, task ID, timestamps, changed files, test results) without parsing display text.
- Raw details (full diffs, complete logs, file contents) are available through:
  - Artifact paths returned in the card response
  - Explicit follow-up tools (`get_task` with `include_logs` or similar detail flags)
  - Result files stored under `.gptwork/goals/<goal_id>/` or task artifact paths

### Impact

- Reduces visual noise in conversational interfaces (ChatGPT, Codex chat).
- Maintains backward compatibility: clients that ignore `structuredContent` still get readable summaries.
- Raw-data consumers can fetch full detail programmatically without display-text interference.

## Tools (MCP Surface)

### Diagnostics & Health
- `gptwork_doctor` — Comprehensive user-facing diagnostics: process info, runtime env, workspace/repo alignment, stale clones, worktree health, Bark/GitHub sync, placeholder tool exposure, suggested next actions
- `runtime_status` — Runtime configuration and git state
- `notification_status` — Bark notification diagnostics
- `health_check` — Basic liveness check

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
- `mkdir`, `delete_path` (permanent — no recycle/trash), `move_path`, `copy_path`
- `search_files`, `sha256_file`
- `create_zip_archive`, `extract_zip_archive`

### Execution
- `shell_exec` — Run a command in a workspace (requires `shell:exec` scope)
- Stable browser tools — Lightweight HTTP browser sessions (HTTP/HTML extraction only, no JS execution) (`browser_new_session`, `browser_goto`, `browser_get_text`, etc.)
- Experimental browser tools — Hidden by default; enable via `GPTWORK_EXPOSE_PLACEHOLDER_TOOLS=true` or `GPTWORK_EXPERIMENTAL_BROWSER_TOOLS=true` (`browser_screenshot`, `browser_set_input_files`, `browser_click_and_download`, `browser_evaluate`)

### GitHub Sync (no reverse proxy flow)
- `sync_to_github` — Push open tasks and requests to GitHub Issues
- `sync_from_github` — Import GitHub Issues as tasks + import comments as ChatGPT responses
- `sync_github_comments` — Check Issue comments for ChatGPT responses
- `github_status` — Show sync configuration

## Repository Layout

```
/ (workspace root: /home/a9017/mcp/workspace)
.gptwork/
  runtime.env                           - Global runtime env (GPTWORK_*)
  state.json                            - Server state
  repos.json                            - Repository registry
  goals/                                - Shared goal files
gpt-codex-workspace/                    - Backend code repo (canonical)
  backend/
    src/cli.mjs                         - Server entry point
    src/gptwork-server.mjs              - MCP handler + tools
    src/ssh-adapter.mjs                 - SSH + SFTP operations
    src/github-adapter.mjs              - GitHub Issues sync
    src/state-store.mjs                 - JSON state persistence
    src/path-utils.mjs                  - Path safety utilities
    src/browser-http.mjs                - Lightweight browser
    test/                               - Test suite
    systemd/gptwork-mcp.service        - systemd unit
  docs/
    architecture.md                     - Architecture document
    current-status.md                   - Current operating state
    chatgpt-app-manifest.json           - ChatGPT App SDK manifest
  plugins/
    gpt-codex-workspace/                - Codex plugin
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
cd /home/a9017/mcp/workspace/gpt-codex-workspace/backend
npm test        # quick test run
npm run test:clean  # isolated test run (unsets all GPTWORK_* env vars)
```

First diagnostic checks after starting the service:

```bash
curl http://127.0.0.1:8787/health
# Then use MCP tools: runtime_status, notification_status, git_remote_status, gptwork_doctor
```



## Context Preview

Before executing large Codex tasks, use the MCP tool:

- `preview_codex_context(task_id)` — Full execution preview: shows what Codex will see before executing a task
- `project_context_status(task_id?)` — Concise context health and source precedence diagnostic: checks canonical repo registration, project.md/project.env existence and sizes/key counts (without secrets), context source precedence (5 layers), and optionally task-specific diagnostics (status, goal, transcript/memory counts). Lightweight alternative when you do not need the full preview.
- `context_prepare(task_id?, mode?)` — Safe auto-fix for context hygiene after diagnostics detect issues. Defaults to `check` (dry-run, no writes). Set `mode=fix_safe` to create missing .gptwork/ directory, project.md, and project.env templates. Never overwrites existing content or exposes secrets. If the repo is dirty or another Codex run is active, stops and reports rather than racing. fix_with_codex mode is reserved for future work without semantic context summarization.

The preview includes:
- Task title, status, mode
- Linked goal ID
- Workspace root and type
- Canonical repo path and remote URL
- Project context files discovered
- Included transcript/memory counts
- Size metrics for transcripts, memories, project files
- Warnings for missing repo, missing goal, dirty worktree, stale clone, or large transcript

## result.json Contract

Codex workers now prefer reading a structured `result.json` file over parsing stdout. When Codex finishes a task, it writes:

```json
{
  "status": "completed|failed|timed_out",
  "summary": "one-line summary of what happened",
  "changed_files": ["src/main.js", "src/utils.js"],
  "tests": "npm test: passed 15/15, 0 failed",
  "commit": "abc123def456...",
  "remote_head": "789ghi012jkl...",
  "warnings": ["Minor lint warnings"],
  "followups": ["Update documentation"]
}
```

The server reads `result.json` first when present, falling back to the existing stdout parser.

## GPTWork Safe Self-Restart Protocol

### Problem

`gptwork-mcp.service` runs the worker that updates task state. If a task directly runs
`systemctl --user restart gptwork-mcp.service` before writing a durable checkpoint, the
worker can be killed before it records the final task result. The replacement process cannot
resume the old in-memory promise or child-process handle.

### Focused Solution

Self-restarts use a two-phase marker protocol instead of direct inline restarts:

1. Finish code/test/commit/push work and write `result.json`.
2. Call `schedule_service_restart(task_id, expected_commit, expected_remote_head)`.
3. GPTWork writes `.gptwork/pending-restarts/<task_id>.json` before scheduling restart.
4. The restart is scheduled detached from the current request.
5. On startup, GPTWork scans pending restart markers, verifies commit state, and finalizes or marks the task for review.

### Tools

| Tool | Description |
|---|---|
| `schedule_service_restart(task_id, expected_commit, expected_remote_head)` | Writes a pending restart marker and schedules a detached restart of `gptwork-mcp.service`. Use this instead of direct inline `systemctl --user restart gptwork-mcp.service`. |
| `list_pending_restarts()` | Lists pending restart markers waiting for startup verification. |

### Minimal Safety Net

Run metadata is still written under `.gptwork/runs/<task_id>/<run_id>/` so startup
reconciliation can prevent tasks from staying `running` forever after a process restart.
This is a fallback only; the primary fix is the pending restart marker protocol.

If a task is found `running` after restart without a pending restart marker and without an
active Codex process, GPTWork marks it `waiting_for_review` with `result.kind=codex_stalled`.
Uncommitted repo changes are preserved.

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `GPTWORK_CODEX_STALL_THRESHOLD_SECONDS` | `600` | Seconds without heartbeat before a running task is considered stalled |

## Environment Configuration

GPTWork uses two levels of environment configuration:

### Service-level (runtime.env)
- Path: `.gptwork/runtime.env` under the workspace root (default)
- Loaded once at process start via `loadRuntimeEnv()`
- Changes require a service restart
- Sets `GPTWORK_*` variables used by the MCP server process
- Override path: `GPTWORK_RUNTIME_ENV_FILE` env var

### Project-level (project.env and project.md)
- Path: `<canonical-repo>/.gptwork/project.env` and `<canonical-repo>/.gptwork/project.md`
- Loaded on every Codex context build (hot-loadable, no restart needed)
- `project.env` uses the same `KEY=VALUE` syntax as `runtime.env` (with `#` comments)
- `project.env` returns vars as a plain object — does NOT mutate `process.env`
- `project.md` is read as UTF-8 text content
- These are safe for project-specific configuration that needs to change without restarting the service
- Do not put secrets into `project.md`; use `project.env` for key/value configuration

See `docs/current-status.md` for the latest operational state and `docs/goal-queue.md` for the goal queue execution.
Queue tools (`enqueue_goal`, `list_goal_queue`, `start_next_queued_goal`, etc.) are now fully exposed in standard/codex/full modes.
See `docs/widget-card.md` for Apps SDK card v2 rendering.



## Bark Notifications

Bark push notifications are sent for task lifecycle events. All events are policy-gated via env vars. Notifications are optional — Bark is not required for GPTWork operation.

### Lifecycle Events

| Event | Default | Description |
|---|---|---|
| created | enabled | Task intentionally assigned to Codex (🆕 GPTWork task created) |
| completed | enabled | Task completed successfully (✅ GPTWork completed) |
| failed | enabled | Task failed or codex_error (❌ GPTWork failed) |
| timed_out | enabled | Task timed out (⏱️ GPTWork timed out) |
| waiting_for_review | enabled | Task reached human-review state (👀 GPTWork waiting for review) |
| started | disabled | Task started (not sent by default) |
| lock-blocked | disabled | Repo-lock waiting states (not sent by default) |

### Created Notifications

Sent user-visible task assigned to Codex via `create_goal`, `create_encoded_goal`, `create_task`, or `assign_task_to_codex`. Not sent for draft tasks, readonly session inventory tasks, or internal/test mode tasks by default.

### Terminal Notifications

Sent for task transitions to completed, failed, timed_out, or waiting_for_review. Title and body include: task id, status, mode, workspace, tests, commit, remote head, summary, changed files, duration.

### Noise Suppression

Repo-lock waiting states never trigger a notification directly. If a lock issue later causes a terminal failure, that notification reflects the actual resolution.

### Deduplication

One notification per task/event/status/channel. Created notification is flagged once; terminal events are flagged once per status.

### Diagnostics

Use `notification_status` tool for safe diagnostic metadata: last attempt/success/failure timestamps, last task id, status, event. Destination and credentials are never exposed.

### Policy Env Vars

| Variable | Default | Effect |
|---|---|---|
| `GPTWORK_BARK_NOTIFY_TASKS` | true | Global notification toggle |
| `GPTWORK_BARK_NOTIFY_CREATED` | true | Notify on task creation |
| `GPTWORK_BARK_NOTIFY_STARTED` | false | Notify on task started |
| `GPTWORK_BARK_NOTIFY_COMPLETED` | true | Notify on completions |
| `GPTWORK_BARK_NOTIFY_FAILURES` | true | Notify on failures |
| `GPTWORK_BARK_NOTIFY_TIMEOUTS` | true | Notify on timeouts |
| `GPTWORK_BARK_NOTIFY_WAITING_REVIEW` | true | Notify on waiting_for_review |
| `GPTWORK_BARK_NOTIFY_LOCK_BLOCKED` | false | Notify on lock-blocked states |
| `GPTWORK_BARK_NOTIFY_READONLY` | false | Notify on readonly tasks |
| `GPTWORK_BARK_NOTIFY_INTERNAL` | false | Notify on internal tasks |
| `GPTWORK_BARK_NOTIFY_TESTS` | false | Notify on test mode tasks |
| `GPTWORK_BARK_NOTIFY_CANCELLED` | false | Notify on cancelled tasks |

## Verification

> The `running_commit` shown in diagnostics (e.g. `runtime_status`) is the git HEAD at verification time. It represents the current filesystem state, not necessarily what the running process loaded at startup. After a deploy task, verify actual service health via `health_check` in addition to commit matching.

## Environment Quick Reference

Key env vars and their defaults:

| Variable | Default | Purpose |
|---|---|---|
| `GPTWORK_HOST` | `127.0.0.1` | Server bind address |
| `GPTWORK_PORT` | `8787` | Server port |
| `GPTWORK_WORKSPACE_ROOT` | `./data/workspaces/default` | Root for hosted workspaces |
| `GPTWORK_STATE_PATH` | `<workspace>/.gptwork/state.json` | Server state file |
| `GPTWORK_CODEX_EXEC_TIMEOUT` | `3600` | Codex execution timeout (seconds) |
| `GPTWORK_CODEX_EXEC_ARGS` | `--yolo --skip-git-repo-check` | Args passed to codex exec |
| `GPTWORK_DEFAULT_REPO` | (empty) | Default owner/repo |
| `GPTWORK_DEFAULT_BRANCH` | `main` | Default git branch |
| `GPTWORK_DEFAULT_REMOTE` | `origin` | Default git remote |
| `GPTWORK_DEFAULT_REPO_PATH` | (empty) | Default local repo path |
| `GPTWORK_BARK_ENABLED` | (auto) | Enable Bark notifications |
| `GPTWORK_BARK_KEY` | (empty) | Bark API key |
| `GPTWORK_BARK_URL` | (empty) | Alternative Bark endpoint URL |
| `GPTWORK_BARK_GROUP` | `gptwork` | Notification group |
| `GPTWORK_GITHUB_ENABLED` | `false` | Enable GitHub Issues sync |
| `GPTWORK_GITHUB_REPO` | (empty) | `owner/repo` for issue sync |
| `GPTWORK_GITHUB_SYNC_LIMIT` | `20` | Max new GitHub Issues imported per worker tick |
| `GPTWORK_SHELL_TIMEOUT` | `60` | Shell command timeout (seconds) |
| `GPTWORK_MAX_OUTPUT_BYTES` | `200000` | Max shell/file output bytes |
| `GPTWORK_CODEX_HOME` | `/home/a9017` | Codex user home |
| `GPTWORK_REQUIRE_AUTH` | `true` | Require API token auth |
| `GPTWORK_TOKENS` | `dev-token,test` | Comma-separated API tokens |
| `GPTWORK_SSH_SOCKS_PROXY` | `10.0.1.105:20177` | SOCKS proxy for SSH workspaces |

**Secrets** (`GPTWORK_BARK_KEY`, `GPTWORK_GITHUB_TOKEN`, `GPTWORK_TOKENS`) must never be committed to version control. Use `.gptwork/runtime.env` which is gitignored.

## Operator Checklist

First diagnostic checks after starting the service:

1. **`runtime_status`** — Check process pid, running commit, workspace root, env loading, git state, and restart markers summary (`restart_markers`)
2. **`notification_status`** — Check Bark notification config and connectivity (no secrets exposed)
3. **`git_remote_status`** — Check remote tracking refs and dirty worktree
4. **`gptwork_doctor`** — Comprehensive single-call diagnostics with suggested next actions
5. **`project_context_status`** — Verify project-level context health (project.md, project.env)

Key verification values after a healthy deployment:

```
defaultWorkspaceRoot=/home/a9017/mcp/workspace
codex_exec_timeout=3600
default_repo=9018/gpt-codex-workspace
default_repo_path=/home/a9017/mcp/workspace/gpt-codex-workspace
runtime_env_loaded=true
github.api_sync_enabled=false
direct_git_reader_available=true
worktree_dirty=false
```


### Using the Dispatch Bridge

1. **Create or update a `gptwork-task` issue** — Open a GitHub Issue with the task description. The `main.yml` workflow auto-adds the `gptwork-task` label for titles matching `[GPTWork Task]`. You can also add the label manually.
2. **Place payloads under `.gptwork/goal-inbox/`** — Create a task descriptor markdown file with YAML front-matter (`kind`, `status`, `assignee`, `mode`, `payload`) and push to `main`. The dispatch workflow automatically discovers and processes it.
3. **Run workflow dispatch manually** — Use `workflow_dispatch` with `issue_number=N` to dispatch an existing issue, or `payload_path=.gptwork/goal-inbox/<file>` to reference a specific payload.
4. **Check Codex worker status** — Use `runtime_status` or `gptwork_doctor` to verify the worker is running and processing tasks.
5. **Inspect task result summaries** — Use `get_task` or check the Actions summary for compact card-style results without flooding the conversation.
6. **Retrieve raw details** — Access full logs, diffs, and artifacts through result artifact paths or by calling `get_task` with detail flags like `include_logs`.

### Reading Compact Cards

- Tool responses show structured cards with status, key metrics, and next actions.
- For more detail, follow the artifact path or `structuredContent` from the response.
- For raw terminal output or full diffs, use explicit follow-up calls (`get_task` with detail flags).

## License

MIT
