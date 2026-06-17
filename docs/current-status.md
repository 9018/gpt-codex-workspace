# GPTWork Current Status
Date: 2026-06-17
Status: P1 cleanup complete: zero-byte test files replaced with minimal smoke tests, chunk-upload placeholder tools removed, browser placeholder tools tagged as [EXPERIMENTAL] and gated behind feature flags, docs clarified for stable vs experimental tool separation.
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


## Bark Notifications

Bark push notifications are sent for task lifecycle events. All events are policy-gated and env-configurable.

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

Sent when a user-visible task is assigned to Codex via:
- Goal creation with Codex assignment (`create_goal` with `assign_to_codex=true`)
- Encoded goal creation (`create_encoded_goal` with `assign_to_codex=true`)
- Direct task creation with Codex assignee (`create_task` with `assignee="codex"`)
- Assigning an existing task (`assign_task_to_codex`)

**Not sent for:** draft tasks, readonly session inventory tasks (by default), internal/test mode tasks.

### Terminal Notifications

Sent for task state transitions to terminal or human-review states:
- `completed`, `failed` / `codex_error`, `timed_out` / `codex_timeout`, `waiting_for_review` / `waiting_review`

Title and body include: task id, status, mode, workspace, tests, commit, remote head, summary, changed files, duration.

### Noise Suppression

Repo-lock waiting / retryable lock-blocked states (`waiting_for_lock`) never send a notification directly. If a task later reaches a true terminal failure or human-review state due to a lock issue, that notification is about the actual resolution state.

### Policy Switches (env vars)

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
| `GPTWORK_BARK_NOTIFY_READONLY` | false | Suppress readonly tasks |
| `GPTWORK_BARK_NOTIFY_INTERNAL` | false | Suppress internal tasks |
| `GPTWORK_BARK_NOTIFY_TESTS` | false | Suppress test mode tasks |
| `GPTWORK_BARK_NOTIFY_CANCELLED` | false | Suppress cancelled tasks |

### Deduplication

One notification per task/event/status/channel:
- `created`: once per task via `notified:bark:created` flag
- Terminal events: once per task/status via `notified:bark:<status>` flag

### Diagnostics

The `notification_status` tool exposes safe metadata:
- `last_task_id`, `last_task_status`, `last_task_event` (e.g. created/completed/failed/timed_out/waiting_for_review)
- `last_attempt_at`, `last_success_at`, `last_failure_at`
- Destination/credentials are never exposed.

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

### MCP Tool: project_context_status / context_status

Two names for the same context health diagnostic:

- `project_context_status(task_id?)` — Canonical name, recommended for scripts and automation.
- `context_status(task_id?)` — Friendly alias, responds naturally to queries like "上下文状态". Calls the same implementation.

Both return:

A new `project_context_status(task_id?)` / `context_status(task_id?)` tool returns a concise context health and source precedence diagnostic. Use this before large Codex runs to verify project-level context is configured and understand what sources contribute to the Codex prompt.

Output fields (base diagnostic, no task_id required):
- `canonical_repo_path` — Absolute path to the canonical repo
- `repo_registered` — Whether the repo is registered in the repo registry
- `workspace_root` — Workspace root directory
- `project_context` — Object with project.md and project.env existence, path, size, key counts (without exposing secret values)
- `context_source_precedence` — Ordered array explaining the 5-layer context precedence:
  1. task.description / task fields
  2. linked goal prompt/context files
  3. project.md / project.env (project-level)
  4. durable goal transcript/memories
  5. runtime defaults / repo registry
- `warnings` — Array of warnings for missing canonical repo, dirty worktree, missing project.md, empty project.env, stale clones, etc.

When `task_id` is provided, the output also includes:
- `task` — Object with task_id, task_status, linked_goal_id, preview_available, transcript_count, memory_count, approximate_context_bytes
- Additional warnings for task_no_linked_goal, huge_context

Use preview_codex_context when you need the full execution preview. Use project_context_status or context_status when you need a quick health check.

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

### MCP Tool: context_prepare

A new `context_prepare(task_id?, mode?)` tool provides safe, non-secret context hygiene fixes after `project_context_status` detects issues.

Supported modes:
- `check` (default) — Dry-run: returns planned safe fixes without writing any files.
- `fix_safe` — Applies only safe, deterministic fixes that require no semantic judgment. Never overwrites existing content.
- `fix_with_codex` — Reserved for future work; not yet implemented.

Safe fixes in fix_safe mode:
1. Create `.gptwork/` directory under canonical repo if missing.
2. Create `.gptwork/project.md` from minimal template (repo name, purpose placeholder, test commands, deploy notes, "Do not store secrets here" warning).
3. Create `.gptwork/project.env` from minimal non-secret template (commented example keys only).
4. Populate empty `project.env` with non-secret template comments.
5. If `task_id` is provided and the task has no linked goal, return a warning with a suggested `create_goal`/`create_task` flow.

Output includes: mode, changed boolean, actions_planned, actions_applied, skipped_actions with reasons, warnings,
project_context_status_before, project_context_status_after (when fix_safe), files_created, files_modified, and no_secrets_exposed flag.

**Never writes secrets.** Does not overwrite existing project.md or project.env content. Refuses to run fix_safe on a dirty worktree to avoid racing.

Comparison:
- `project_context_status` = diagnose context health
- `preview_codex_context` = full execution preview
- `context_prepare(check)` = dry-run plan
- `context_prepare(fix_safe)` = creates safe missing project context templates


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


## Per-Repository Codex Execution Lock

GPTWork serializes Codex builder/deploy/admin tasks per canonical repository to prevent concurrent edits that could corrupt the worktree.

### Lock File

```
.gptwork/locks/repos/<safe-repo-id>.json
```

The `<safe-repo-id>` is a filesystem-safe identifier derived from the canonical repo path using a SHA-256 hash prefix and a cleaned path:

```
<12-char-hex>-<cleaned-path>
```

Example for `/home/a9017/mcp/workspace/gpt-codex-workspace`:

```json
{
  "canonical_repo_path": "/home/a9017/mcp/workspace/gpt-codex-workspace",
  "safe_repo_id": "0eb1aa94d0b6-home--a9017--mcp--workspace--gpt-codex-workspace",
  "task_id": "task_xxx",
  "run_id": "uuid-here",
  "pid": 12345,
  "acquired_at": "2026-06-17T12:00:00.000Z",
  "last_heartbeat_at": "2026-06-17T12:00:00.000Z",
  "mode": "deploy",
  "restart_state": null,
  "status": "held"
}
```

### Lock Acquisition

Before spawning Codex for a builder/deploy/admin task, `processGeneralTask` acquires a repo lock keyed by the canonical repo path (`config.defaultRepoPath`):

1. If no lock exists for that repo, a new lock file is created with `status: "held"`.
2. If a lock exists with `status: "released"`, it can be overwritten.
3. If a lock is held by **the same task** (re-entrant), the heartbeat is updated and acquisition succeeds.
4. If a lock is held by **a different task**, acquisition returns `{ acquired: false, heldByTask }` — the task is marked `waiting_for_lock` with log message, `lock_blocked_by` metadata (holding task id), and Codex is not spawned. No Bark notification is sent for `waiting_for_lock`.

### Lock Release

The lock is released after Codex execution completes (regardless of result: completed, failed, or timed out) unless:

- **Safe-restart scheduled**: If the task has an active restart marker (pending/scheduled/restarted), the lock stays held with `restart_state: "scheduled"` during the restart window. The lock is released after Phase C verification finalizes the task.

### Lock Retry (waiting_for_lock)

When a builder/deploy/admin task encounters a held repo lock, it is set to `waiting_for_lock` status. This is a non-terminal, transient state:

- The `run_assigned_codex_tasks` worker includes `waiting_for_lock` in its candidate filter, so blocked tasks are automatically retried on each worker tick (default interval: 5 seconds).
- On each retry, `acquireRepoLock` is called again. If the lock is now free, the task proceeds to `running` and Codex execution begins.
- If the lock is still held, the task remains `waiting_for_lock` with updated `lock_blocked_by` metadata.
- On retry, any stale `lock_blocked_at` / `lock_blocked_by` fields are cleared before attempting lock acquisition.
- No Bark notification is sent for `waiting_for_lock` transitions — this is a transient internal state, not a terminal status requiring human review.

### How Same-Repo Concurrency Is Blocked

The `runAssignedCodexTasks` tool processes assigned tasks with bounded concurrency (default: 4). For each builder/deploy/admin task, it calls `processGeneralTask` which:

1. Checks if the task has a canonical repo path
2. Calls `acquireRepoLock` — if another task holds the lock, the current task is marked `waiting_for_lock` with `lock_blocked_by` metadata and log: `"repo locked by task X, retry after completion. Skipping."`
3. If lock acquired, proceeds to spawn Codex normally

Since lock acquisition happens early in `processGeneralTask` (before marking `running`), two concurrent worker ticks cannot both spawn Codex for the same repo.

### Stale Lock Reconciliation

The `reconcileStaleTasks` method (called on worker startup) includes Phase B that reconciles repo locks:

- If lock heartbeat is older than 15 minutes and the lock owner's child process is dead, the lock is marked `stale`.
- If the lock has `restart_state` and the restart marker is still active, the lock is kept.
- If the lock has `restart_state` but no restart marker exists, the lock is marked `stale`.
- Worktree changes are never discarded automatically.

### What to Do If Repo Lock Is Stale

1. Check `list_repo_locks` or `runtime_status.repo_locks` for active/stale counts.
2. If a lock is stale (owner task completed or crashed), it will be reconciled automatically on the next worker tick or service restart.
3. For manual release, the lock file can be edited to set `"status": "released"` or deleted.
4. The `forceReleaseRepoLock` function in the module provides programmatic release.

### Diagnostics

Available via:
- `runtime_status.repo_locks` — `{ active_repo_locks, stale_repo_locks, locks[] }`
- `gptwork_doctor.repo_locks` — Same summary, integrated into doctor output
- `list_repo_locks` — Standalone tool with safe fields (no secrets)

### MCP Tools

| Tool | Description |
|---|---|
| `runtime_status` (repo_locks field) | Active/stale repo lock counts and lock entries |
| `gptwork_doctor` (repo_locks field) | Same repo lock summary integrated into doctor diagnostics |
| `list_repo_locks` | Standalone tool listing repo execution locks with safe diagnostics |
