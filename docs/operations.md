# GPTWork Operations Runbook

This runbook covers the current operational paths for GPTWork: project context diagnostics, runtime checks, recovery, safe restart, release delivery checks, and repo cleanliness.

## Operational Semantics

Keep these facts separate during triage:

| Term | Meaning |
|---|---|
| verification | Commands/checks passed. |
| acceptance | The user goal is satisfied. |
| integration | The change is in canonical main or integration was not required. |
| deployment | The running environment is using the expected commit/configuration. |
| closure | The task can be closed. |
| review | Human judgment is required; this is not automatically failure. |

Do not collapse state:

- `branch_pushed != merged`
- `pr_opened != merged`
- `merged != deployed`
- `health 200 != running expected commit`
- `quality_notes` / `non_blocking_followups` do not block current task closure

## First Look

For a normal ChatGPT or operator session, start with:

```text
open_project_context
```

This gives a compact project snapshot: repo identity, worker/queue status, recent goals/tasks, useful scripts, bounded file tree, and recommended next tools. It is the preferred first call instead of reading raw state files or full goal context.

For a task review, prefer:

```text
get_task_review_packet(task_id)
get_task_acceptance_bundle(task_id)
```

These compact packets should be enough for most closure/review decisions without full transcript, durable memories, complete context bundle, or large diffs.

## Product Status Dashboard

For a single-pane-of-glass overview, use:

```text
product_status
```

This replaces reading 10+ separate tool results and answers the high-signal questions:
* Is the project making progress?
* Where is it stuck?
* What should I do next?

### Dashboard Sections

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

### Design Principles

1. **Raw counts vs actionable blockers**: The `current_blockers` section explicitly separates raw non-terminal task counts from policy-filtered actionable blockers, so you know which are real problems vs historical noise.
2. **Review categorization**: Review tasks are classified as `human_required` (needs manual decision), `machine_repairable` (can auto-repair), or `resolved_history` (legacy-resolved, safe to ignore).
3. **Next actions are prioritized**: Each action carries a priority label (`blocker`, `warning`, `info`) so you know what to address first.
4. **Text and card**: The output renders via both the Apps SDK card system (rich view) and plain-text fallback for terminal/script consumption.

### When to use product_status vs individual tools

| Use case | Tool |
|---|---|
| First glance at project health | `product_status` |
| Deep queue inspection | `worker_status` |
| Detailed worker diagnostics | `gptwork_doctor` |
| Review packet for a specific task | `get_task_review_packet(task_id)` |
| Retention planning | `retention_status` |
| TUI session debugging | `codex_tui_status` |


## Context Diagnostics

Use either tool name:

```text
project_context_status(task_id?)
context_status(task_id?)
```

Check:

- canonical repo registration and path alignment
- `.gptwork/project.md` / `.gptwork/project.env` presence and safe sizes/key counts
- context source precedence
- optional task-specific context diagnostics
- `context_index` configured/effective store
- optional Zvec dependency availability
- bundle budgets, top-K limits, max goals scanned, and warnings

These tools must not expose secret values. Zvec is a rebuildable context index, not a fact source.

If safe context hygiene fixes are needed, inspect `context_prepare(task_id?, mode?)`. Use `mode=check` first; use `fix_safe` only when the repo is clean and the proposed non-secret template changes are acceptable.

## Runtime Health

### Basic Liveness

```bash
curl http://127.0.0.1:8787/health
```

Expected shape: `{"ok":true,"service":"gptwork-mcp","time":"..."}`.

This is only process liveness. It does not prove the process is running the expected commit.

### Runtime Status

```text
runtime_status
```

Check:

- `running_commit` against the expected commit
- restart mode and restart marker status
- active restart markers
- active repo locks
- worker enabled/running state
- queue counts and blocker hints
- runtime env loaded flag

Use `running_commit` plus restart markers to determine deployment state after a merge or restart. A green health endpoint alone is insufficient.

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

Use these for environment, tool mode, widget, queue, GitHub/Bark, state-store, and shell boundary checks.

## Recovery Plane

Recovery tools are for unblocking state, not for hiding missing evidence.

Common paths:

- Stale queue: `recovery_stale_queue_unblock` after `gptwork_doctor` confirms the queue state.
- Repo locks: inspect `runtime_status.repo_locks` or `list_repo_locks`; clear only stale locks with evidence that no worker owns them.
- Retention: run `retention_status`, then dry-run `retention_cleanup`; apply only after reviewing the proposed removals.
- Tmp and goal cleanup: use `tmp_status`, `cleanup_tmp`, `goal_storage_status`, and `cleanup_goals` with dry-run behavior when available.
- Missing result/report: prefer review packet and recovery evidence. If evidence is genuinely missing, keep `missing_evidence` visible.

Recovery should not convert `branch_pushed` or `pr_opened` into `merged`, and should not treat `health 200` as deployment proof.

## Safe Restart

When a Codex task needs GPTWork itself restarted, use the two-phase protocol. Do not restart inline from the worker process.

Required order:

1. Finish edits, verification, commit, and result files.
2. Write `result.json` and `result.md` with the final task result.
3. Call `schedule_service_restart(task_id, expected_commit, expected_remote_head?)`.
4. Let GPTWork write a restart marker and schedule the restart detached from the current task.
5. After startup, verify `runtime_status.running_commit` and restart marker state.

Do not run raw `systemctl restart`, `pkill`, or inline process-kill commands from a self-restart task. Doing so can kill the worker before result writeback finishes.

## Release Delivery Check

Use the narrow current gate before handing off documentation or delivery-contract changes:

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

## Repo Clean Check

Before marking a task complete, verify the execution worktree:

```bash
git status --short
```

Expected after commit and result writeback: no uncommitted files in the execution repo, except goal result files outside the repo when the task contract requires writing them there.

For canonical repo integration checks, confirm:

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

1. Need project overview: call `open_project_context` (or `product_status` for a compact status dashboard).
2. Need context health: call `project_context_status` / `context_status`.
3. Need task review: call `get_task_review_packet`.
4. Need liveness: `curl /health`, then `runtime_status` for expected commit.
5. Worker not advancing: inspect `worker_status`, queue counts, repo locks, and waiting-for-review tasks.
6. Integration unclear: inspect integration status and require `merged === true` or `status === "merged"` for merge completion.
7. Deployment unclear: compare running commit/config to expected target, not only HTTP 200.
8. Before completion: run release checks, commit, write result files, and confirm repo clean.

## Related Docs

- [Current Status](current-status.md)
- [Architecture](architecture.md)
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md)
- [GitHub Fallback](github-fallback.md)
- [中文主文档](../README.zh-CN.md)
