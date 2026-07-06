# GPTWork Operations Runbook

This runbook covers the current production operations model for GPTWork: worker lifecycle, queue semantics, repo locks, safe restart protocol, runtime diagnostics, retention boundaries, auto-terminalization evidence reconciliation, recovery plane, and operator troubleshooting.

## Core Operational Semantics

Keep these state distinctions separate during triage:

| Term | Meaning |
|---|---|
| verification | Commands/checks passed. |
| acceptance | The user goal is satisfied. |
| integration | The change is in canonical main or integration was not required. |
| deployment | The running environment uses the expected commit/configuration. |
| closure | The task can be closed. |
| review | Human judgment is required; this is not automatically failure. |

Do not collapse these state boundaries:

- `branch_pushed` ≠ `merged`
- `pr_opened` ≠ `merged`
- `merged` ≠ `deployed`
- `health 200` ≠ `running expected commit`
- `quality_notes` / `non_blocking_followups` do not block current task closure

## Worker Lifecycle

### Worker State Machine

The Codex worker progresses through these states:

| Phase | Description | Diagnose With |
|---|---|---|
| `disabled` | Worker is not enabled — no ticks run. | `worker_status` → `health.phase` |
| `enabled_but_not_running` | Enabled but never started a tick, or between ticks (idle). | `worker_status` → `enabled:true, running:false` |
| `running` | A tick is actively executing. | `worker_status` → `running:true`, `health.phase:running` |
| `overdue` | Next tick is overdue by >3× the expected interval — worker may be stuck. | `health.phase:overdue`, `health.next_tick_overdue_ms` |
| `stalled` | Last tick finished >6× the interval ago — worker has stopped making progress. | `health.phase:stalled`, `health.last_tick_age_ms` |

### Worker Status Fields

`worker_status` returns these fields from `workerStatusExtendedSnapshot`:

| Field | Meaning |
|---|---|
| `enabled` | Boolean — worker is running its main loop. |
| `running` | Boolean — a tick is currently executing. |
| `started_at` | ISO timestamp when the worker started. |
| `last_tick_started_at` | ISO timestamp of the current or most recent tick. |
| `last_tick_finished_at` | ISO timestamp when the last tick finished. |
| `last_tick_duration_ms` | Wall-clock duration of the last tick. |
| `interval_ms` | Configured tick interval. |
| `current_interval_ms` | Effective interval (could be adaptive). |
| `next_tick_due_at` | ISO timestamp when the next tick is due. |
| `concurrency` | Max concurrent tasks per tick. |
| `limit` | Max tasks scanned per tick. |
| `last_tick_result` | Result summary: `{ok, inspected, completed, skipped}` or `{ok:false, error}`. |
| `last_error` | Error string from the last failed tick. |
| `health` | Object with `{phase, last_tick_age_ms, current_tick_duration_ms, next_tick_overdue_ms, reason}`. |

### Health Phase Diagnostics

The health phase is computed by `computeWorkerHealth`:

- **disabled**: `workerState.enabled === false`.
- **enabled_but_not_running**: Enabled but never started, or between ticks normally.
- **running**: A tick is actively running (`workerState.running === true`). `current_tick_duration_ms` shows how long.
- **overdue**: Next tick overdue by >3× interval — the loop may be blocked on I/O or a slow operation.
- **stalled**: Last tick finished >6× interval ago — the worker process may be wedged or the event loop blocked.

Use `worker_status` to inspect the current state, and `gptwork_doctor` for deeper diagnostics.

---

## Queue Semantics

### Task Statuses

The queue tracks Codex-assigned tasks across these statuses:

| Status | Meaning | Raw Blocker | Policy Blocker |
|---|---|---|---|
| `assigned` | Task created and assigned to Codex. | Yes | Depends on policy |
| `queued` | Waiting in the goal queue for a worker slot. | No | No |
| `running` | Currently executing. | No | No |
| `waiting_for_lock` | Holding repo lock or waiting for one. | Yes | Yes |
| `waiting_for_review` | Needs human or machine review. | Yes | Policy-filtered |
| `waiting_for_repair` | Auto-repair is needed. | Yes | Yes |
| `waiting_for_integration` | Depends on git push / PR merge. | Yes | Yes |
| `completed` | Task completed successfully. | No | No |
| `failed` | Task completed with failure. | Yes | Policy-filtered |

### current_blockers: Raw vs Policy-Filtered

`current_blockers` in `product_status` and `queue-health-metrics` reports two numbers:

| Metric | Source | Meaning |
|---|---|---|
| `current_blockers.raw` | Sum of all non-terminal, non-queued, non-completed statuses. | Everything that *could* be a problem. |
| `current_blockers.policy_filtered` | Only tasks that pass `isPolicyCurrentBlockerTask` policy checks. | Tasks that actually block current work. |
| `current_blockers.policy_excluded` | `raw - policy_filtered` | Tasks excluded by policy (resolved legacies, implicit successors, provider-empty results). |

### Policy Decision Logic

`isPolicyCurrentBlockerTask(task, indexes)` checks:

1. Task must be Codex-assigned and in a non-terminal, non-completed status.
2. `policyCurrentWorkDecision` applies `classifyCurrentBlockerTask` then checks:
   - **Failed/timed-out tasks**: excluded if they have an implicit successor (`hasImplicitSuccessor`) or are `isResolvedLegacyTerminalTask`.
   - **Waiting_for_review tasks**: excluded if they are resolved legacy review tasks (`isResolvedLegacyReviewTask`).
3. Only tasks where `blocks_current_work === true` count as current blockers.

### actionable_review

`actionable_review` is the policy-filtered count of tasks in `waiting_for_review` status. This is distinct from the raw `waiting_for_review` count because:

- Tasks marked `resolved_by_task_id` or `superseded_by_task_id` are excluded.
- Tasks resolved by legacy reconciliation (`isResolvedLegacyReviewTask`) are excluded.
- Tasks whose result shape is provider-empty (`PROVIDER_EMPTY_SHAPES`) are excluded.
- Tasks in `true_human_review` statuses (via `TRUE_HUMAN_REVIEW_STATUSES`) remain actionable.

### Implicit Successor Detection

`hasImplicitSuccessor(failedTask, indexes)` determines if a failed/timed-out task has been inherently resolved by a later task:

1. **Direct reference**: Successor's `parent_task_id`/`root_task_id`/`repair_of_task_id` matches any of the failed task's own relation IDs.
2. **Full relation set**: Successor's full task relation set (including `result.repair.*`) references the failed task's ID.
3. **Shared goal**: Both tasks serve the same `goal_id` and a completed task with completion evidence exists for that goal.

---

## Blocker Manifest Categories

The `blocker-manifest.mjs` module (P0-MA11-R6) classifies each current blocker into one of five categories:

| Category | Description | Operator Action |
|---|---|---|
| `auto_terminalizable` | Provider-empty / resolved / no-op tasks that can be auto-completed safely. | Let the reconciler handle it. |
| `deterministic_repair_needed` | Code or failure evidence that is stale/legacy and can be repaired deterministically. | Run `gptwork_doctor`, consider repair. |
| `external_wait` | `waiting_for_integration` — depends on external infra (git push, PR merge). | Check git/CI external to GPTWork. |
| `true_human_review` | Requires human judgment. | Review with `get_task_review_packet(task_id)`. |
| `unresolved_failure` | Real unresolved failure with evidence. | Inspect with `gptwork_doctor`, triage. |

### Deterministic Convergence Evidence

`canDeterministicallyConverge(task, indexes)` checks if a task can be safely auto-completed:

1. **Explicit resolution markers**: `noop`, `resolved_legacy`, `resolved_by_task_id`, `superseded_by_task_id`.
2. **Already integrated commit**: Commit reachable from HEAD + passing verification evidence.
3. **Delivery recovery**: `delivery_result_recovery.reason === 'already_integrated'` with passing verification.
4. **Verification normalized**: Canonical `verification.passed === true` + `contract_verification.blocking_passed === true`.
5. **Integration already merged/skipped**: `integration.status === 'merged'` or `'skipped'`.
6. **Provider-empty result shape** with no failure evidence.
7. **Has implicit successor**: Shared-goal completed task with completion evidence.

### Result Shape Classification

`classifyResultShape(result)` returns one of:

| Shape | Meaning |
|---|---|
| `no_result` | No result object exists. |
| `provider_noop` | Explicit noop marker or kind like `already_integrated`. |
| `provider_timeout` | `kind === 'codex_timeout'` or `failure_class === 'codex_timeout'`. |
| `provider_no_evidence` | `kind === 'codex_failed'` without evidence. |
| `failure_evidence` | Result contains failure evidence (errors, failures). |
| `code_evidence` | Result contains changed files, tests, or commits. |
| `completion_evidence` | Result has passing verification/reviewer/integration evidence. |

---

## Repo Locks

### Lock Lifecycle

Repo locks are stored as JSON files under `.gptwork/locks/repos/` with a safe key derived from the repo path (SHA-256 prefix + cleaned path).

| Status | Description | blocks_current_work | diagnostic_level |
|---|---|---|---|
| `held` | Active lock — a worker currently holds this lock. | true | `active` |
| `stale` | Lock is stale — heartbeat not updated within `STALL_THRESHOLD_MS` (15 min). | true | `blocker` |
| `released` | Lock was released or superseded. | false | `history` |

### Lock Fields (Safe Diagnostics)

`list_repo_locks` and `runtime_status.repo_locks` expose these safe fields:

| Field | Description |
|---|---|
| `safe_repo_id` | Filesystem-safe repo identifier. |
| `canonical_repo_path` | Original repo path. |
| `task_id` | Task holding the lock. |
| `run_id` | Execution run ID. |
| `status` | `held`, `stale`, or `released`. |
| `mode` | Lock mode (shared/exclusive). |
| `acquired_at` | ISO timestamp of acquisition. |
| `last_heartbeat_at` | ISO timestamp of last heartbeat. |
| `restart_state` | Restart state if set (safe string). |
| `stale_reason` | Reason if status is `stale` or was released as stale. |

### Stale Lock Threshold

`STALL_THRESHOLD_MS = 900_000` (15 minutes). A lock without heartbeat updates beyond this threshold is candidate for stale status. The runtime reconciler (`reconcileRuntimeRepoLocks`) handles automatic stale detection during tick reconciliation.

### Diagnosing Lock Issues

```text
runtime_status    # check repo_locks section
list_repo_locks   # full lock details
```

Recovery: clear only stale locks with evidence that no worker owns them. Do not clear `held` locks unless the owning task is confirmed dead.

---

## Safe Restart Protocol

### Two-Phase Restart

When a Codex task needs GPTWork restarted, use the strict two-phase protocol. **Do not restart inline** from the worker process — this can kill the worker before result writeback finishes.

**Phase A — Schedule:**
1. Finish edits, verification, commit, and result files.
2. Write `result.json` and `result.md` with the final task result.
3. Call `schedule_service_restart(task_id, expected_commit, expected_remote_head?)`.
4. GPTWork writes a restart marker and schedules the restart detached from the current task.

**Phase B — Restart marker states:**

Restart markers progress through these states (see `safe-restart-marker-store.mjs`):

| Status | Meaning |
|---|---|
| `pending` | Marker written, restart not yet triggered. |
| `scheduled` | Restart has been dispatched to the service manager. |
| `restarted` | Service restarted, reconciler will verify on startup. |
| `verified` | Post-restart verification passed (running commit matches expected). |
| `failed` | Verification failed (commit mismatch or health check failure). |
| `cancelled` | Restart was cancelled. |

**Phase C — Startup verification (reconciler):**

On startup after a restart, the `reconcileRestartMarkers` reconciler (Phase C) runs and:

1. Scans pending restart markers.
2. Migrates misplaced markers from repo-level paths to canonical workspace path.
3. For `scheduled`/`restarted` markers: runs `verifyRestartMarker` which checks:
   - Running commit matches `expected_commit` from the marker.
   - Optionally verifies `expected_remote_head` matches.
   - Service health endpoint is responsive.
4. On verification success:
   - Updates marker to `verified` status.
   - Loads task's existing `result.json` (from goal directory).
   - Validates autonomy policy (`validateAutonomyResult`).
   - Writes synthesized restart evidence (`buildVerifiedAdminRestartResult`).
   - Sets task to `completed`, releases repo lock.
   - Converges linked admin restart goal.
5. On verification failure:
   - Marks marker as `failed` with `failure_reason`.
   - Sets task to `waiting_for_review` with `restart_state: 'failed'`.
   - Releases repo lock.
6. For `pending` markers (pre-verified before restart):
   - Verifies running commit matches expected.
   - Updates to `verified` status.
   - Does NOT complete the task (it was already complete before scheduling).

### Misplaced Marker Handling

The reconciler detects and migrates restart markers written to old repo-level paths (`<repo>/.gptwork/pending-restarts/`) to the canonical workspace path. Duplicate misplaced markers are removed.

### Runtime Commit Checks

After startup, verify:

```text
runtime_status    # check running_commit vs expected
```

A green `health 200` endpoint alone is insufficient. Use `running_commit` plus restart marker state to determine deployment state.

---

## Runtime Diagnostics

### TUI Runtime Diagnostics

`codex-tui-runtime-diagnostics.mjs` provides Codex TUI session diagnostics:

| Metric | Source | Meaning |
|---|---|---|
| `enabled` | Config or env var `GPTWORK_CODEX_TUI_ENABLED` | Whether Codex TUI provider is enabled. |
| `provider` | `CODEX_EXECUTION_PROVIDERS` | Selected execution backend. |
| `sessions_dir_exists` | Filesystem check | Whether the TUI sessions directory exists. |
| `total_sessions` | Session file count | Total TUI session records found. |
| `active_sessions` | Sessions with `status in {created, starting, running}` | Currently active TUI sessions. |
| `invalid_records` | Parse failures | Corrupted session records. |
| `findings` | Severity-sorted diagnostics | Warnings/errors for operator attention. |

Key TUI session statuses: `created`, `starting`, `running`, `completed`, `failed`, `cancelled`.

### Runtime Status Command

```text
runtime_status
```

Returns:
- `running_commit` — the commit SHA the running process was built from.
- `restart_mode` — whether a restart is pending/in-progress.
- `restart_markers` — active restart markers and their states.
- `repo_locks` — active/stale/released lock summary.
- `worker` — worker enabled/running state and health phase.
- `queue` — queue counts and blocker hints.
- `env_loaded` — whether runtime env vars were loaded.

### Product Status Dashboard

```text
product_status
```

Aggregates system, worker, queue, blockers, review, retention, TUI provider, and prioritized next actions.

### product_status Sections

| Section | What it tells you |
|---|---|
| **System** | Running commit, repo head, worktree cleanliness, runtime env, tool mode |
| **Worker** | Worker enabled/running state, health phase, last tick age, concurrency |
| **Queue** | Assigned, queued, running, completed, failed counts |
| **Current Blockers** | Raw non-terminal count vs policy-filtered actionable blockers |
| **Review** | Human-required vs machine-repairable vs resolved-history review tasks |
| **Raw Historical** | Legacy-resolved and unresolved totals (for context, not actionable) |
| **Retention** | Storage pressure, task/goal counts vs limit |
| **TUI Provider** | TUI session count, active sessions, findings severity |
| **Config** | Bark/GitHub enablement, agent backend |
| **Next Actions** | Prioritized action items (blocker / warning / info) |

### When to use product_status vs individual tools

| Use case | Tool |
|---|---|
| First glance at project health | `product_status` |
| Deep queue inspection | `worker_status` |
| Detailed worker diagnostics | `gptwork_doctor` |
| Review packet for a specific task | `get_task_review_packet(task_id)` |
| Retention planning | `retention_status` |
| TUI session debugging | `codex_tui_status` |

### Queue Health Metrics

```text
collectQueueHealthMetrics    # programmatic or via gptwork_doctor
```

Reports automation effectiveness KPIs:

| Metric | Meaning |
|---|---|
| `auto_acceptance_rate` | Fraction of completed tasks with auto-accept evidence. |
| `auto_advance_rate` | Fraction of queue items that auto-advanced. |
| `manual_review_escape_rate` | Tasks that needed human review despite automation. |
| `repair_loop_success_rate` | Repair attempts that led to completion. |
| `provider_noise_rate` | Provider no-result/timeout as fraction of total. |
| `raw_state_drift_count` | Tasks where raw status differs from policy interpretation. |
| `policy_excluded_count` | Tasks excluded from current blockers by policy. |
| `state_migration_count` | Tasks that needed state migration (legacy → typed). |
| `time_to_close_ms` | Average ms from creation to terminal completion. |

---

## Context Diagnostics

Use either:

```text
open_project_context          # compact project snapshot
project_context_status(task_id?)  # detailed context diagnostics
context_status(task_id?)      # same, alternate name
```

Check:
- canonical repo registration and path alignment
- `.gptwork/project.md` / `.gptwork/project.env` presence and safe sizes
- context source precedence
- optional task-specific context diagnostics
- `context_index` configured/effective store
- optional Zvec dependency availability
- bundle budgets, top-K limits, max goals scanned, and warnings

These tools must not expose secret values.

---

## First Look / Normal Entry Point

### Basic Liveness

```bash
curl http://127.0.0.1:8787/health
```

Expected: `{"ok":true,"service":"gptwork-mcp","time":"..."}`. This is only process liveness — it does not prove the process is running the expected commit.

For a normal operator session, start with:

```text
open_project_context
```

This gives a compact snapshot: repo identity, worker/queue status, recent goals/tasks, useful scripts, bounded file tree, and recommended next tools.

### Worker Status

```text
worker_status
```

Use this to see whether Codex is enabled/running and what task counts are assigned, queued, running, waiting for lock, waiting for review, completed, or failed.

### Doctor and Self-Test

```bash
cd backend
node bin/gptwork.mjs doctor --local
node bin/gptwork.mjs self-test --local
```

MCP equivalents:

```text
gptwork_doctor
gptwork_self_test
```

Use these for environment, tool mode, widget, queue, GitHub/Bark, state-store, shell boundary, and TUI diagnostics checks.

## Release Delivery Check

Use the narrow release gate before handing off documentation or delivery-contract changes:

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

For behavior changes, add targeted tests and consider:

```bash
cd backend
npm test
npm run test:e2e-acceptance
npm run test:e2e-delivery
```

`node scripts/release-delivery-check.mjs --fast` is a fast release gate. It does not replace task-specific tests when code behavior changes.

### Worktree Clean Check

Before marking a task complete, verify the execution worktree:

```bash
git status --short
```

Expected after commit and result writeback: no uncommitted files in the execution repo, except goal result files outside the repo when the task contract requires writing them there.

### Retention Gate Script

```bash
cd backend
node scripts/release-storage-pressure.mjs
```

Reports storage pressure for task/goal counts vs configured limits. Can be wired into CI/CD as a pre-release gate.

---

## Retention Cleanup Boundaries

### Goal Storage Limits

| Parameter | Default | Warning Threshold | Action |
|---|---|---|---|
| `DEFAULT_MAX_GOAL_DIRS` | 100 | ≥85 (85%) | `bin/gptwork.mjs goals cleanup --dry-run` to preview |
| `DEFAULT_MAX_FILES` | 5000 | ≥4250 (85%) | `--apply` to archive terminal goals |

### Managed Tmp Thresholds

| Parameter | Warning Threshold | Action |
|---|---|---|
| `TMP_COUNT_WARN` | ≥1000 files | `bin/gptwork.mjs tmp cleanup --dry-run` |
| `TMP_BYTES_WARN` | ≥500 MB | `--apply` only after reviewing |

### Inode Pressure

When system inode usage on `/tmp` exceeds 85%, tmp cleanup is recommended if GPTWork-owned tmp files are contributing.

### Default Behaviour

Worker idle maintenance (`worker-maintenance.mjs`) is **dry-run only by default**. Warnings are logged to `GPTWORK_LOG_PATH`. To enable auto-applied cleanup, set:

```bash
export GPTWORK_AUTO_MAINTENANCE=true
```

### Retention Pressure Levels (`product_status`)

| Level | Criteria |
|---|---|
| `none` | Tasks ≤ limit (default 50) AND goals ≤ limit. |
| `medium` | Tasks or goals exceed the limit but ≤ 2× limit. |
| `high` | Tasks or goals exceed 2× limit. |

Limit is configurable via `GPTWORK_RETENTION_LIMIT` (default: 50).

---

## Auto-Terminalization Evidence Reconciliation

### What It Does

The auto-terminalization system (blocker-manifest.mjs P0-MA11-R6, stale-state-sweeper.mjs, legacy-reconciliation.mjs) automatically resolves tasks that are no longer blocking current work by detecting convergence evidence.

### Evidence Categories

The reconciler checks these evidence categories in order:

1. **Explicit resolution markers** — `noop: true`, `resolved_legacy: true`, `resolved_by_task_id`, `superseded_by_task_id`.
2. **Already integrated commit** — Task's `result.commit` is reachable from HEAD + `verification.passed === true`.
3. **Delivery recovery** — `delivery_result_recovery.reason === 'already_integrated'` with passing verification.
4. **Verification normalized** — Canonical `verification.passed === true` + `contract_verification.blocking_passed === true`.
5. **Integration already merged/skipped** — `integration.status === 'merged'` or `'skipped'`.
6. **Provider-empty result shape** — `no_result`, `provider_noop`, `provider_timeout`, `provider_no_evidence` with no failure evidence.
7. **Implicit successor** — A completed task with completion evidence for the same goal or referencing the failed task's IDs.

### Diagnosing Auto-Terminalization Issues

When auto-terminalization is not resolving tasks as expected, check these in order:

**Step 1: Check the blocker manifest**

The R6 manifest is written to `<state-dir>/r6-manifest/blocker-manifest.json` during each reconciliation. It shows every current blocker with its manifest category and evidence summary.

**Step 2: Check convergence result**

`<state-dir>/r6-manifest/convergence-result.json` shows which tasks were converged and which were skipped, with reasons.

**Step 3: Check evidence presence**

For a task that should have been auto-terminalized but wasn't:

- Is `hasCompletionEvidence(task.result)` true? (checks `closure_decision`, `reviewer_decision`, `verification.passed`, `integration.merged/skipped`).
- Does `classifyResultShape(task.result)` return a provider-empty shape? Check the `result_shape` field.
- Is the task's commit reachable from HEAD? Run `git merge-base --is-ancestor <commit> HEAD`.

**Step 4: Check policy decision**

```
policyCurrentWorkDecision(task, indexes)
```

Returns `{blocks_current_work, label, reason}`. Key labels:

| Label | Meaning | blocks_current_work |
|---|---|---|
| `active` | Task is actively running or queued. | false |
| `review` | Task is waiting for review. | true |
| `integration` | Task is waiting for integration. | true |
| `completed` | Task is completed. | false |
| `provider_empty` | Result has no actionable evidence. | false |
| `failure_evidence` | Result has failure evidence. | true |
| `code_evidence_failure` | Result has code evidence but failure status. | true |
| `resolved_by_options` | Task has resolution markers. | false |

**Step 5: Legacy reconciliation check**

For historical tasks:

- `isResolvedLegacyTerminalTask(task)` checks for no-result failures, completion evidence with integration, historical provider failures.
- `isHistoricalProviderNoResultFailure(task)` checks for provider timeouts, no-ops, and codex failures without code evidence, changed files, tests, or commits.

**Step 6: Implicit successor check**

```
hasImplicitSuccessor(task, indexes)
```

Returns true if a later completed task with evidence references the failed task via parent_task_id, root_task_id, repair_of_task_id, or shared goal_id.

### Common Diagnostic Commands

| Scenario | Command |
|---|---|
| Check reconciler output | `cat .gptwork/r6-manifest/blocker-manifest.json | jq '.manifest[] | {task_id, category, evidence}'` |
| Check convergence result | `cat .gptwork/r6-manifest/convergence-result.json | jq '.converged[] | {task_id, reason}'` |
| Check worker logs | Check `GPTWORK_LOG_PATH` for `[gptwork-worker] MA11-R6:` entries. |
| Run doctor | `gptwork_doctor` — reports worker state and queue health. |
| View product status | `product_status` — current blockers vs policy-filtered. |
| Detailed queue health | `collectQueueHealthMetrics` — automation effectiveness KPIs. |

---

## Recovery Plane

Recovery tools are for unblocking state, not for hiding missing evidence.

Common paths:

| Issue | Tool | Precondition |
|---|---|---|
| Stale queue | `recovery_stale_queue_unblock` | `gptwork_doctor` confirms stale queue state. |
| Stale repo locks | `runtime_status.repo_locks` or `list_repo_locks` | Evidence that no worker owns the lock (no heartbeat, task is dead). |
| Retention pressure | `retention_status` → `retention_cleanup --dry-run` | Review proposed removals before applying. |
| Tmp buildup | `tmp_status` → `cleanup_tmp --dry-run` | Review proposed removals before applying. |
| Goal storage | `goal_storage_status` → `cleanup_goals --dry-run` | Review proposed removals before applying. |
| Missing result/report | Review packet + recovery evidence | If evidence is genuinely missing, keep `missing_evidence` visible. |

Recovery should not convert `branch_pushed` or `pr_opened` into `merged`, and should not treat `health 200` as deployment proof.

### Integration Checks

For canonical repo integration:
- expected branch/worktree was used
- ff-only merge succeeded when integration was required
- post-merge verification ran when required
- `branch_pushed` or `pr_opened` is not being treated as merge completion
- deployment/restart evidence exists when the user asked for a running service change

## GitHub Issues Fallback

If ChatGPT cannot reach a public HTTPS MCP endpoint, use the GitHub fallback path:

```text
sync_from_github
sync_to_github
sync_github_comments
github_status
```

Token values must come from runtime environment or workflow secrets. Do not place tokens in docs, Issues, goal payloads, results, or review packets.

## Troubleshooting Checklist

| Step | Action | Tool/Command |
|---|---|---|
| 1 | Project overview | `open_project_context` or `product_status` |
| 2 | Context health | `project_context_status` / `context_status` |
| 3 | Task review | `get_task_review_packet(task_id)` |
| 4 | Worker not advancing | `worker_status`, queue counts, repo locks, waiting-for-review tasks |
| 5 | Stale locks | `runtime_status` → `repo_locks` section, `list_repo_locks` |
| 6 | Integration unclear | Inspect integration status; require `merged === true` |
| 7 | Deployment unclear | Compare `running_commit`/config to expected target, not only HTTP 200 |
| 8 | Auto-terminalization not converging | Check R6 manifest, convergence result, evidence presence |
| 9 | Retention pressure | `retention_status`, dry-run cleanup, apply only after review |
| 10 | Before completion | Run release checks, commit, write result files, confirm repo clean |

## Productized Capabilities

### Product Status Dashboard

For a single-pane-of-glass overview, use `product_status`. It aggregates system, worker, queue, blockers, review, retention, TUI provider, and prioritized next actions into one compact dashboard. This is the recommended first call for operators.

### Agent Backend Configuration

When configuring which execution backend to use per role, set:

```bash
GPTWORK_AGENT_BACKEND=codex_exec        # global default (default: codex_exec)
GPTWORK_AGENT_ROLE_BACKENDS=verifier=local_command,reviewer=local_command
GPTWORK_AGENT_LOCAL_COMMAND=npm --prefix backend test
GPTWORK_AGENT_ROLE_COMMANDS=verifier=npm --prefix backend test||reviewer=node scripts/review.mjs
```

### Onboarding Commands

Productized onboarding flow:

```bash
cd backend
gptwork init          # One-shot initialization + diagnostics
gptwork doctor --local  # Full diagnostics
gptwork fix           # Auto-fix missing files and dependencies
gptwork status --local  # Quick status check
```

## Related Docs

- [Current Status](current-status.md)
- [Architecture](architecture.md)
- [Goal Queue](goal-queue.md)
- [Queue Auto-Advance](queue-auto-advance.md)
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md)
- [GitHub Fallback](github-fallback.md)
- [中文主文档](../README.zh-CN.md)

---
*Documentation-only update. For implementation details, see the backend source under `backend/src/`.*
*Worker state: `codex-worker-state.mjs`, `codex-worker-runner.mjs`*
*Queue semantics: `worker-queue-counts.mjs`, `queue-health-metrics.mjs`, `current-blocker-policy.mjs`*
*Blocker manifest: `blocker-manifest.mjs`, `legacy-reconciliation.mjs`*
*Repo locks: `repo-lock-diagnostics.mjs`, `repo-lock-paths.mjs`*
*Safe restart: `safe-restart.mjs`, `runtime-reconciler-restart-markers.mjs`*
*Runtime diagnostics: `codex-tui-runtime-diagnostics.mjs`, `diagnostics-service.mjs`*
*Retention: `worker-maintenance.mjs`, `retention-cleanup.mjs`*
*Reconciler: `runtime-reconciler.mjs`, `stale-state-sweeper.mjs`*
