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

1. `runtime_status` — Check process pid, running commit, workspace root, env loading, git state
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

## Codex Stuck-Task Diagnostics & Recovery

### Problem Addressed

Tasks can stay `running` indefinitely with logs ending at `[worker] codex exec started`. Codex may modify files but fail to commit/push/complete the task. Previously there was no task heartbeat, run id, child pid, stdout/stderr artifact, last progress time, or recovery tool.

### New Tools

Three MCP tools added for diagnostics and recovery:

| Tool | Description |
|---|---|
| `diagnose_task(task_id)` | Returns structured diagnostics: status, age, last heartbeat, active process, repo dirty state, changed files, run log paths, result.json presence, likely cause, and suggested recovery actions |
| `list_stuck_tasks()` | Lists all running/stalled tasks with stale heartbeat, missing process, or no progress |
| `recover_stuck_task(task_id, action)` | Perform recovery: inspect_only, mark_waiting_review, mark_failed, reset_to_assigned, finalize_if_result_json, kill_process_if_alive |

### Recovery Workflow

When a task appears stuck:

1. **Diagnose**: `diagnose_task("<task_id>")` — returns structured diagnostics with likely cause and suggested actions.
2. **List all stuck**: `list_stuck_tasks()` — see all running tasks with stale heartbeats.
3. **Recover**:
   - If repo is dirty (Codex made changes but didn't commit): `recover_stuck_task("<task_id>", "mark_waiting_review")`
   - If repo is clean and task should be retried: `recover_stuck_task("<task_id>", "reset_to_assigned")`
   - If result.json exists: `recover_stuck_task("<task_id>", "finalize_if_result_json")`
   - If the Codex process is still alive but hung: `recover_stuck_task("<task_id>", "kill_process_if_alive")`
   - Safe inspection without changes: `recover_stuck_task("<task_id>", "inspect_only")`

### Run Metadata

Each Codex execution creates run metadata at:

```text
.gptwork/runs/<task_id>/<run_id>/run.json
```

Each run records:
- `run_id`, `task_id`, `started_at`, `last_heartbeat_at`, `phase`
- `codex_child_pid` when available
- `stdout_log_path`, `stderr_log_path` — durable log files
- `result_json_path` if result.json is found

Phases: `preparing`, `running_codex`, `parsing_result`, `completed`, `failed`, `stalled`

### Run Logs

Full Codex stdout/stderr captured per run:

```text
.gptwork/runs/<task_id>/<run_id>/stdout.log
.gptwork/runs/<task_id>/<run_id>/stderr.log
```

### Startup Reconciliation

When the service starts, tasks in `running` status with stale heartbeats and no active process are automatically marked `waiting_for_review` with `result.kind=codex_stalled`. Uncommitted repo changes are preserved — never reverted automatically.

### What To Do When Repo Is Dirty After Codex Stalls

1. `diagnose_task("<task_id>")` — confirm the repo is dirty and see changed files.
2. Review the changed files manually or via `git diff`.
3. Either:
   - `recover_stuck_task("<task_id>", "mark_waiting_review")` — mark for human review.
   - Keep the changes and create a new task to continue from where Codex left off.
   - Manually commit the changes if they are correct and desired.
4. Do NOT use `mark_failed` or `reset_to_assigned` without checking the dirty state first.

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `GPTWORK_CODEX_STALL_THRESHOLD_SECONDS` | `600` | Seconds without heartbeat before a running task is considered stalled |

