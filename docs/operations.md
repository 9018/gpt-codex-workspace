# GPTWork Operator Runbook

> **Delivery System Status**: The core delivery pipeline (create → queue → worktree → execute → verify → complete) is **integrated** into the main flow. All health checks, diagnostics, restart verification, lock management, and retention cleanup procedures below apply to the fully integrated system. The repair loop and serial integration queue remain **experimental** — see [Delivery Architecture](delivery/multi-task-delivery-architecture.md) for details on which components are still being hardened.

---

Concise operational guide for the npm-managed GPTWork service. Covers health checks, restart verification, locks, retention cleanup, and recovery.

---

## Health Checks

### 1. Basic Liveness

```bash
curl http://127.0.0.1:8787/health
```

Expected: `{"ok":true,"service":"gptwork-mcp","time":"..."}`

### 2. Runtime Diagnostics (MCP tool)

```
runtime_status
```

Check these fields:

- `running_commit` — should match expected HEAD (current: `c171ef83749c2def90f014d384433ae142c645dd`)
- `restart_mode` — must be `npm` (default restart strategy)
- `restart_marker_kind` — must be `npm`
- `restart_markers.active_count` — should be `0` (no pending/scheduled restarts)
- `restart_markers.statuses` — breakdown of all marker states
- `repo_locks.active_repo_locks` — should be `0` (no active execution locks)
- `worker.enabled` / `worker.running` — worker state
- `env_loaded` — must be `true`

### 3. Comprehensive Diagnostics (MCP tool)

```
gptwork_doctor
```

Returns green/yellow/red diagnostics with `suggested_next_actions`. Checks process info, runtime env, workspace/repo alignment, stale clones, worktree health, Bark/GitHub sync, tool exposure, and restart markers.

### 4. Self-Test (MCP tool)

```
gptwork_self_test
```

Expected baseline: **12 PASS / 0 WARN / 0 FAIL**.

Health categories checked: process state, runtime env, tool mode matrix, shell_exec boundary, timeout, widgets, GitHub/Bark status, config sources, state store.

### 5. Worker Status (MCP tool)

```
worker_status
```

Returns Codex worker process state (enabled, running, timing, last error) and queue counts (assigned, queued, running, waiting_for_lock, waiting_for_review, completed, failed).

---

## Restart Verification

The default restart strategy is **npm-managed** (not systemd).

### Current Restart Configuration

| Field | Value |
|---|---|
| restart_mode | `npm` |
| restart_marker_kind | `npm` |
| restart_cwd | `/home/a9017/mcp/workspace/gpt-codex-workspace/backend` |
| restart_command_summary | `npm run start` |
| restart_instruction | `cd "/home/a9017/mcp/workspace/gpt-codex-workspace/backend" && npm run start` |

### Manual Start

```bash
cd /home/a9017/mcp/workspace/gpt-codex-workspace/backend
npm run start
```

### Check Restart Markers

MCP tool:

```
runtime_status
```

- `restart_markers.total_count` — all marker files (active + historical)
- `restart_markers.active_count` — markers with status `pending`, `scheduled`, or `restarted` (should be `0` in steady state)
- `restart_markers.statuses` — breakdown by status

Markers with `verified` or `failed` status are historical — no action needed.

### Safe Restart (two-phase protocol)

When a Codex task needs to restart the service:

1. Finish code/test/commit/push and write `result.json`.
2. Call `schedule_service_restart(task_id, expected_commit, expected_remote_head)`.
3. GPTWork writes a pending restart marker, schedules a detached restart.
4. On startup, GPTWork verifies commits and finalizes the task.

**Never** use inline `systemctl` or raw process kill from inside a Codex task — always use `schedule_service_restart`.

---

## Lock Checks

Repo execution locks serialize Codex builder/deploy/admin tasks per canonical repository.

### Check Locks

MCP tool:

```
runtime_status  →  repo_locks field
```

or

```
list_repo_locks
```

Expected steady state: `active_repo_locks=0`, `stale_repo_locks=0`.

### If a Lock Is Stale

- Automatic reconciliation runs on worker startup (Phase B).
- Heartbeat older than 15 minutes with a dead child process → lock marked `stale`.
- For manual release: edit `.gptwork/locks/repos/<safe-repo-id>.json` to set `"status": "released"` or delete the file.

---

## Retention / Rolling Cleanup

GPTWork provides configurable retention limits for record families (tasks, goals, queue items, agent runs, ChatGPT requests, restart markers, goal files, run metadata).

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `GPTWORK_RETENTION_ENABLED` | `true` | Enable/disable retention checks |
| `GPTWORK_RETENTION_LIMIT` | `50` | Per-category rolling limit |
| `GPTWORK_RETENTION_DRY_RUN_DEFAULT` | `true` | Default to dry-run mode |
| `GPTWORK_RETENTION_ARCHIVE_BEFORE_DELETE` | `true` | Archive filesystem records before deletion |

### Check Retention Status

MCP tool:

```
retention_status
```

Returns per-category inventory: current count, active vs terminal, bytes, oldest/newest, proposed action under current limit.

### Run Cleanup

**Always dry-run first:**

```
retention_cleanup
# dry_run=true by default — reports without changing
```

Apply when satisfied:

```
retention_cleanup(dry_run: false)
# or retention_cleanup(apply: true)
```

Safety guarantees:

- Never removes active/open/running/assigned/queued records.
- Supports per-category limit override.
- Archive-before-delete is enabled by default.
- Writes admin audit log.

---

## Recovery Tools

### Stale Queue Unblock

If the goal queue has a stalled entry blocking further processing:

MCP tool:

```
recovery_stale_queue_unblock
```

Subject to precondition validation. Use `gptwork_doctor` first to confirm the queue state.

### Lock Recovery

Stale repo locks are reconciled automatically on the next worker tick or service restart. For manual intervention, see [Lock Checks](#lock-checks) above.

### Default Healthy State

| Check | Expected |
|---|---|
| `gptwork_self_test` | 12 PASS / 0 WARN / 0 FAIL |
| `runtime_status.restart_markers.active_count` | 0 |
| `runtime_status.repo_locks.active_repo_locks` | 0 |
| `curl /health` | `{"ok":true}` |
| Worktree | clean (no uncommitted changes) |

---

## Change Log / Current State

### 2026-06-23: npm Restart as Default

- **npm restart** replaced systemd as the default restart strategy.
- `restart_mode=npm`, `restart_marker_kind=npm`.
- Systemd remains available as a legacy/optional deployment mode but is no longer the default.
- `runtime_status` reports full restart strategy configuration.
- `gptwork_self_test` baseline: 12 PASS / 0 WARN / 0 FAIL.
- Retention management tools (`retention_status`, `retention_cleanup`) with dry-run-first safety.
- Recovery tools: `recovery_stale_queue_unblock`, lock auto-reconciliation.

Key commits:

| Commit | Description |
|---|---|
| `de3b525` | Implement GPTWork rolling retention limit |
| `a059f2f` | Replace systemd restart flow with npm-managed restart flow |
| `e83d635` | Finalize npm restart diagnostics and self-test |
| `c171ef8` | Live npm restart closure — kill old process so new process can bind port |

---

## Links

- [Architecture](architecture.md)
- [Current Status](current-status.md)
- [Setup & Connection](setup-connect.md)
- [Goal Queue](goal-queue.md)
- [E2E Acceptance](e2e-acceptance.md)
- [README (English)](../README.md)
- [README (中文)](../README.zh-CN.md)
