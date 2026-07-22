# Operations

> Source-backed as of 2026-07-22.

## Day-2 Commands

```bash
gptwork status --local
gptwork doctor --local
gptwork self-test --local
gptwork logs
```

Queue:

```bash
gptwork queue list
gptwork queue start-next
gptwork queue enqueue <goal_id>
gptwork queue cancel <queue_id>
```

Storage / retention:

```bash
gptwork tmp status
gptwork tmp cleanup --dry-run
gptwork goals storage-status
gptwork goals cleanup --dry-run
gptwork retention status
gptwork retention cleanup --dry-run
```

## Runtime Files

Important paths under workspace root:

```text
.gptwork/state.json
.gptwork/runtime.env
.gptwork/goals/
.gptwork/worktrees/
.gptwork/codex-sessions/
.gptwork/logs/
.gptwork/reports/
.gptwork/pending-restarts/
.gptwork/repos.json
```

Process helpers:

```text
/tmp/gptwork-mcp.pid
```

## Worker Operations

Worker is off by default in code (`GPTWORK_CODEX_WORKER=false`).

Enable it for autonomous execution:

```dotenv
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_WORKER_INTERVAL_MS=5000
GPTWORK_CODEX_WORKER_CONCURRENCY=4
```

Behavior:

- startup stale-task reconciliation
- periodic GitHub sync if configured
- idle backoff when no progress
- maintenance / historical convergence on a longer interval

Inspect via tools:

- `worker_status`
- `runtime_status`
- `product_status`
- `gptwork_doctor`

## Task Ops Patterns

### Task not starting

Check:

1. worker enabled
2. task `assignee=codex`
3. task `mode=full`
4. status is an active candidate
5. repo lock not held
6. workspace type is `hosted`

### Task stuck in waiting_for_review

Common causes:

- missing/indeterminate evidence
- acceptance findings requiring human judgment
- repair budget exhausted
- provider unavailable without heal path

Use:

- `get_task`
- `get_task_review_packet` / supervisor review tools
- goal `result.md` / `result.json`
- TUI session tools if session-owned

### Task stuck in waiting_for_integration

Worker has explicit retry path for `waiting_for_integration` / `integrating`.

Check:

- integration lock
- branch push/remote state
- auto-integration completion evidence
- whether external merge is required

### Repair storms

Do not manually requeue endlessly.

Inspect:

- `repair_attempt` / `max_attempts`
- parent/repair lineage fields
- finalizer reason codes
- convergence result

## Safety Controls

Relevant knobs:

```text
GPTWORK_SHELL_MODE=full|safe|off
GPTWORK_WRITE_MODE=workspace|handoff|off
GPTWORK_RECOVERY_PLANE_ENABLED=true|false
GPTWORK_BREAK_GLASS_ENABLED=...
GPTWORK_RECOVERY_ALLOWED_ROOTS=...
```

Recovery tools are intentionally separated from normal product tools.

## Notifications

Bark notifier can emit task created/terminal notifications when configured:

```text
GPTWORK_BARK_ENABLED
GPTWORK_BARK_URL
GPTWORK_BARK_KEY
...
```

## Release / Canary

From `backend/`:

```bash
npm run check:syntax
npm run check:imports
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

There are additional specialized gates:

- state-boundary
- autonomous-runtime
- ma9 / p5 release gates

Prefer clean worktree when cutting release candidates.

## Incident Checklist

1. `curl /health`
2. `gptwork doctor --local`
3. `worker_status` / `runtime_status`
4. inspect `.gptwork/state.json` task status distribution
5. inspect affected `.gptwork/goals/<id>/`
6. check repo locks and worktrees
7. only then use recovery/break-glass tools
