# GPTWork Current Status

Date: 2026-06-17
Status: encoded goal workflow is implemented and tuned for GPTChat -> Codex execution on 10.0.1.103. All P0 UX items resolved: placeholder tools gated by default, gptwork_doctor diagnostic tool added, workspace/repo registration validated.

## What This Project Is

GPTWork is one backend MCP service used by two clients:

- ChatGPT connects through the public domain and creates shared goals.
- Codex connects through the marketplace plugin and executes those goals in a workspace.
- The backend stores tasks, goals, readable goal files, context, transcript, bundles, and results.

Recommended ChatGPT endpoint:

```text
https://mcp.gptwork.cc.cd/mcp/dev-token
```

Recommended Codex plugin source:

```text
9018/gpt-codex-workspace
```

## Current Ports And Routes

| Item | Value | Purpose |
|---|---|---|
| Backend host | `10.0.1.103` | Remote server running GPTWork |
| Backend port | `8787` | MCP backend HTTP service |
| Public URL | `https://mcp.gptwork.cc.cd/mcp/dev-token` | ChatGPT connector URL, auth mode none |
| LAN MCP URL | `http://10.0.1.103:8787/mcp` | Codex plugin and local testing |
| Workspace root | `/home/a9017/mcp/workspace` | Default hosted workspace root |
| Backend repo | `/home/a9017/mcp/workspace/gpt-codex-workspace` | Canonical code repo (workspace-relative) |
| Lucky admin | `16601` | Reverse proxy admin UI |
| Legacy ports | None | No legacy port is part of the target architecture |

Path-based auth is the preferred ChatGPT setup. The backend extracts the token from `/mcp/<token>`, so ChatGPT does not need to send an Authorization header.

## Current Workflow

```text
User natural language request
  -> ChatGPT writes a readable preview
  -> ChatGPT builds payload JSON
  -> ChatGPT sends create_encoded_goal(preview_text, payload_base64, assign_to_codex=true, wait_ms=90000)
  -> Backend decodes base64 and saves readable files
  -> Backend creates/links task and assigns Codex
  -> Codex reads .gptwork/goals/<goal_id>/goal.md and context.json
  -> Codex executes, writes result.md, and GPTWork appends the result to the shared transcript
  -> ChatGPT receives an execution snapshot in the same tool response when wait_ms is set
```

Primary ChatGPT entry:

```text
create_encoded_goal
```

Compatibility entries still work:

- `create_goal` remains available.
- `create_task` automatically creates a linked goal.
- `assign_task_to_codex` automatically links old tasks to a goal.
- If `create_task.description` contains a `gptwork.encoded_goal.v1` envelope, the backend decodes it and creates the readable goal context.

## Encoded Goal Files

Every goal writes these workspace files:

```text
.gptwork/goals/<goal_id>/goal.md
.gptwork/goals/<goal_id>/context.json
.gptwork/goals/<goal_id>/transcript.md
.gptwork/goals/<goal_id>/payload.json
.gptwork/goals/<goal_id>/payload.base64
.gptwork/goals/<goal_id>/result.md
```

The public `create_encoded_goal` response intentionally returns only concise paths (`dir`, `goal_md`, `result_md`). Internal/debug paths (`context.json`, `transcript.md`, `payload.json`, `payload.base64`) are available as `internal_files` and through `get_goal_context`. Attachment directories are only created and returned when a bundle is uploaded.

Important boundary: base64 is transport encoding only. The user sees the readable preview, the backend stores readable JSON/Markdown, and Codex executes readable instructions.

## Attachments

Instruction payloads use:

```text
JSON -> base64
```

File bundles use:

```text
zip -> base64
```

Available bundle tools:

- `upload_bundle_base64`
- `download_bundle_base64`
- existing `create_zip_archive` / `extract_zip_archive`

## First Diagnostic Checks

After starting the service, verify with these MCP tools (in order):

1. `runtime_status` — Check process pid, running commit, workspace root, env loading, git state, and safe restart markers summary (`restart_markers`)
2. `notification_status` — Check Bark notification config and connectivity
3. `git_remote_status` — Check remote tracking refs and dirty worktree
4. `gptwork_doctor` — Comprehensive single-call diagnostics with suggested next actions

Key verification values after a healthy deployment:

```
defaultWorkspaceRoot=/home/a9017/mcp/workspace
codex_exec_timeout=2400
default_repo=9018/gpt-codex-workspace
default_repo_path=/home/a9017/mcp/workspace/gpt-codex-workspace
runtime_env_loaded=true
github.api_sync_enabled=false
direct_git_reader_available=true
worktree_dirty=false
```


## Context Layer (v3 Feature)

### MCP Tool: preview_codex_context

A new `preview_codex_context(task_id)` tool shows what Codex will see before execution. Use this before large Codex runs to verify the execution environment.

Preview fields:
- Task title, status, mode
- Linked goal ID
- Workspace root and type
- Canonical repo path
- Runtime/state paths
- Project context files discovered (.gptwork/project.md, .gptwork/project.env)
- Included transcript/memory counts
- Acceptance criteria / constraints summary
- Approximate size metrics
- Warnings for missing repo, missing goal, dirty worktree, stale clone, or huge transcript

### Project-Level Context Files

Project-level configuration is now supported under the canonical repo:

- `.gptwork/project.md` — Project-level Markdown context, hot-loaded on each Codex context build
- `.gptwork/project.env` — Project-level env vars (KEY=VALUE), hot-loaded on each Codex context build
- These are distinct from `runtime.env` (service-level, requires restart)
- `project.env` is parsed safely like runtime.env but does NOT mutate process.env
- Do not put secrets into project.md

### result.json Contract

Codex workers now prefer reading a structured `result.json` file. Contract:

| Field | Type | Description |
|---|---|---|
| `status` | string | `completed`, `failed`, or `timed_out` |
| `summary` | string | One-line summary |
| `changed_files` | string[] | Files modified during execution |
| `tests` | string | Test command and outcome |
| `commit` | string | Local commit SHA |
| `remote_head` | string | Remote HEAD SHA |
| `warnings` | string[] | Warning messages |
| `followups` | string[] | Follow-up items |

The server reads result.json first when present, falling back to the existing stdout parser.


## Codex Worker Defaults

The backend worker runs Codex with:

```bash
codex exec --yolo --skip-git-repo-check < promptFile
```

Override with:

```bash
GPTWORK_CODEX_EXEC_ARGS="--yolo --skip-git-repo-check"
```

Codex execution timeout defaults to 300 seconds. Override with:

```bash
GPTWORK_CODEX_EXEC_TIMEOUT=300
```

Zip operations use Python. Override if needed:

```bash
GPTWORK_PYTHON=python3
```

## Expected Environment (runtime.env)

Actual config is loaded from `/home/a9017/mcp/workspace/.gptwork/runtime.env`. Key values:

```bash
GPTWORK_HOST=0.0.0.0
GPTWORK_PORT=8787
GPTWORK_REQUIRE_AUTH=true
GPTWORK_STATE_PATH=/home/a9017/mcp/workspace/.gptwork/state.json
GPTWORK_TOKENS=dev-token,test
GPTWORK_WORKSPACE_ROOT=/home/a9017/mcp/workspace
GPTWORK_RUNTIME_ENV_FILE=/home/a9017/mcp/workspace/.gptwork/runtime.env
GPTWORK_CODEX_HOME=/home/a9017
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_WORKER_INTERVAL_MS=5000
GPTWORK_CODEX_WORKER_CONCURRENCY=4
GPTWORK_CODEX_EXEC_ARGS=--yolo --skip-git-repo-check
GPTWORK_DEFAULT_REPO=9018/gpt-codex-workspace
GPTWORK_DEFAULT_BRANCH=main
GPTWORK_DEFAULT_REPO_PATH=/home/a9017/mcp/workspace/gpt-codex-workspace
GPTWORK_DEFAULT_REMOTE=origin
GPTWORK_SSH_SOCKS_PROXY=10.0.1.105:20177
```

SSH workspaces prefer key authentication. For hosts outside `10.0.0.0/8`, the default SOCKS proxy is `10.0.1.105:20177` unless a workspace-specific proxy is configured.

## Docs Kept

| File | Purpose |
|---|---|
| `README.md` | Project overview and quick start |
| `docs/current-status.md` | Current operating state |
| `docs/architecture.md` | System design |
| `docs/chatgpt-prompting-guide.md` | ChatGPT encoded goal behavior |
| `docs/chatgpt-app-manifest.json` | ChatGPT MCP connector metadata |
| `plugins/gpt-codex-workspace/skills/workspace-coordination/SKILL.md` | Codex workflow skill |

Removed/obsolete docs should not describe base64 as a way to hide unsafe intent.

## GPTWork Safe Self-Restart Protocol

### Root Cause Addressed

The recurring stuck-task issue was caused by a task restarting `gptwork-mcp.service` while
that same service was running the worker. The restart killed the worker before it could
write a final task result or complete the task. The new backend process cannot resume the
old in-memory execution chain.

### Focused Protocol

Self-restarts now use a durable two-phase marker flow:

1. Finish code/test/commit/push work.
2. Write `result.json`.
3. Call `schedule_service_restart(task_id, expected_commit, expected_remote_head)`.
4. GPTWork writes `.gptwork/pending-restarts/<task_id>.json` before scheduling restart.
5. The restart is detached from the current worker request.
6. On startup, GPTWork scans pending restart markers, verifies running/local/remote commit,
   and finalizes or marks the task for review.

### MCP Tools

| Tool | Description |
|---|---|
| `runtime_status` (restart_markers field) | Safe summary of restart markers: total_count (all marker files), active_count (active: pending/scheduled/restarted only), statuses breakdown (pending/scheduled/restarted/verified/failed), marker_dir_exists. Verified/failed markers are historical and do not require action. |
| `schedule_service_restart(task_id, expected_commit, expected_remote_head)` | Writes a pending restart marker and schedules a detached restart. |
| `list_pending_restarts()` | Lists pending restart markers awaiting startup verification. |

### Active vs Historical Markers

The `restart_markers` field distinguishes between active and historical markers:

- **total_count**: Number of all marker files found in the restart marker directory.
- **active_count**: Count of markers with status `pending`, `scheduled`, or `restarted`. These represent in-progress or incomplete restarts that may need attention.
- **statuses**: Breakdown counts by individual status (pending/scheduled/restarted/verified/failed).
- **marker_dir_exists**: Whether the marker directory exists at all.

Markers with status `verified` or `failed` are historical — the restart protocol has already completed or ended for those tasks. The `total_count` includes all markers (active + historical), while `active_count` only includes markers that still need action. Verified historical markers do not generate warnings in `gptwork_doctor suggested_next_actions`.

### Marker Path

```text
.gptwork/pending-restarts/<task_id>.json
```

Marker fields include `task_id`, `requested_at`, `requested_by`, `service_name`,
`expected_commit`, `expected_remote_head`, `repo_path`, `restart_kind`, `status`, `logs`,
and `attempts`.

### Minimal Fallback Reconciliation

Run metadata remains under `.gptwork/runs/<task_id>/<run_id>/` as a fallback. On startup,
if a task is still `running`, has no pending restart marker, has stale heartbeat, and has no
active Codex process, GPTWork marks it `waiting_for_review` with
`result.kind=codex_stalled`. Repo changes are never discarded automatically.

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `GPTWORK_CODEX_STALL_THRESHOLD_SECONDS` | `600` | Seconds without heartbeat before a running task is considered stalled |

