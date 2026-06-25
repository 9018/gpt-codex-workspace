# GPTWork GitHub Fallback Guide

> **Audience**: Users and operators who rely on GitHub Issues as a fallback channel
> when ChatGPT `create_task` / `create_goal` is blocked or inconvenient.
>
> **Prerequisites**: GPTWork backend running with GitHub API sync configured
> (`GPTWORK_GITHUB_ENABLED=true`, `GPTWORK_GITHUB_TOKEN`, `GPTWORK_GITHUB_REPO`).

---

## Overview

When ChatGPT's direct `create_task` / `create_goal` tools are unavailable or
impractical, GitHub Issues serve as a reliable alternative entry point for
GPTWork task intake.

There are **three distinct GitHub entry points**, each with a specific label
and processing path:

| Entry | Label | Route | Purpose |
|-------|-------|-------|---------|
| Normal task issue | `gptwork-task` | `sync_from_github` / `import_task_handoffs` | Import a task description as a Codex-executable task |
| ChatGPT question / request | `gptwork-question` | `sync_from_github` (optional) | Read-only discussion; does not create a task by default |
| Task-intake (upgrade from question) | `gptwork-task-intake` + body marker | `sync_from_github` / `import_task_handoffs` | Convert a question/request issue into an executable task |
| Payload dispatch | `gptwork-dispatch` | GitHub Actions `gptwork-dispatch.yml` | Bundle large payloads (ZIP, restore files) via goal-inbox |

**Critical rule**: A single issue should carry **one role at a time**.
Do not use `gptwork-task` for payload dispatch, and do not use
`gptwork-dispatch` for plain text task intake.

---

## 1. Label Taxonomy

### `gptwork-task`

- **Meaning**: "This is a plain-text Codex task."
- **Processing**: `sync_from_github` (`importFromIssues`) imports it as a new
  task. The dispatch workflow (`gptwork-dispatch.yml`) explicitly **skips**
  issues that have only `gptwork-task` (no dispatch label), preventing
  "GPTWork dispatch failed" noise.
- **When to use**: You have a task description in natural language, and you
  want Codex to execute it. No ZIP bundles, no restore instructions, no
  base64 payloads.

### `gptwork-question`

- **Meaning**: "This is a ChatGPT request or a general question, not a task."
- **Processing**: `sync_from_github` reads the issue but **does not** create
  a task unless a `task-intake` marker is also present.
- **When to use**: You want to record a question or request for ChatGPT
  without triggering Codex execution.

### `gptwork-task-intake` (label or body marker)

- **Meaning**: "This question/request issue is allowed to become a task."
- **Processing**: When the label `gptwork-task-intake` is present, or the
  body contains a valid intake marker (see [Task-Intake Markers](#task-intake-markers)),
  `import_task_handoffs` treats the issue as convertible.
- **When to use**: You initially created a `gptwork-question` issue but
  later decided it needs Codex execution. Add the marker and re-sync.

### `gptwork-dispatch`

- **Meaning**: "This issue references a payload in the goal-inbox."
- **Processing**: The GitHub Actions dispatch workflow (`gptwork-dispatch.yml`)
  reads the payload reference from the issue body and calls `create_goal` on
  the MCP backend. This is **not** processed by `sync_from_github`.
- **When to use**: You have a large bundled payload (ZIP, restore file, or
  multiple files) that cannot be described in plain text alone.

### Auto-labeling

The `main.yml` workflow auto-adds labels based on issue title:

- `[GPTWork Task]` or `[Task]` → `gptwork-task`
- `[GPTWork Question]` or `[Question]` → `gptwork-question`

You can also add labels manually.

---

## 2. Issue Templates

### 2a. Normal Codex Task Issue (`gptwork-task`)

```
Title: [GPTWork Task] Implement the data export feature
Labels: gptwork-task

## Description

Build a CSV export endpoint for the /api/export route.

## Acceptance Criteria

- Endpoint returns CSV for a given date range
- Handles empty datasets gracefully
- Includes error handling for invalid input

## Notes

No external dependencies required.
```

### 2b. ChatGPT Request / Question Issue (`gptwork-question`)

```
Title: [GPTWork Question] How does the delivery pipeline work?
Labels: gptwork-question

## Question

I want to understand how the multi-task delivery pipeline routes tasks from
creation through execution to completion. Could you explain the flow?

## Context

I read the architecture docs but I'm unsure about the worktree isolation
mechanism.
```

### 2c. Payload Dispatch Issue (`gptwork-dispatch`)

```
Title: [Dispatch] Deploy monitoring stack
Labels: gptwork-dispatch

## Bundle

This issue dispatches a ZIP bundle from the goal-inbox.

Payload references (at least one required):

ZIP base64: `.gptwork/goal-inbox/monitoring-stack-v2.zip.b64`
Restore instructions: `.gptwork/goal-inbox/monitoring-stack-v2-restore.md`
Fallback queued task file: `.gptwork/goal-inbox/monitoring-stack-v2-task.md`

## Description

Deploy the monitoring stack to production:
- Prometheus with alerting rules
- Grafana dashboards
- Node exporter setup
```

---

## 3. Task-Intake Markers

A question/request issue becomes convertible to a task when it carries a
task-intake marker. Three formats are recognized:

### Frontmatter (recommended)

Place YAML frontmatter at the start of the issue body:

```
---
gptwork_intake: task
assign_to: codex
mode: builder
workspace_id: hosted-default
---

The rest of the issue body follows here.
```

### JSON block

Include a JSON block anywhere in the body:

```json
{
  "gptwork_intake": "task",
  "assign_to": "codex",
  "mode": "builder",
  "workspace_id": "hosted-default"
}
```

### Label

Add the `gptwork-task-intake` label to the issue. No body change needed.

### Marker Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `gptwork_intake` | yes | — | Must be `"task"` |
| `assign_to` | no | `"codex"` | Assignee for the created task |
| `mode` | no | `"builder"` | Execution mode |
| `workspace_id` | no | `"hosted-default"` | Target workspace |

---

## 4. User Operation Flow

### Flow A: Direct (ChatGPT available)

When ChatGPT's `create_task` / `create_goal` tools work:

1. Issue the command directly in ChatGPT.
2. Check the result with `get_task` / `runtime_status`.
3. No GitHub issue needed.

### Flow B: GitHub fallback (create_task blocked)

When ChatGPT's `create_task` / `create_goal` is blocked by platform policy:

1. Create a GitHub issue with the task description.
2. Ensure the issue has the `gptwork-task` label (auto-added if title starts
   with `[GPTWork Task]` or `[Task]`; add manually otherwise).
3. Call `sync_from_github` or `import_task_handoffs(source: "github", dry_run: true, apply: true)`.
4. Check the response fields:
   - `imported_tasks` — number of tasks imported (should be ≥ 1).
   - `tasks[].id` — the created task ID (e.g., `task_abc123`).
   - `tasks[].status` — task status after import (usually `queued`).
   - `last_scanned_issue_count` — how many open issues were scanned.
   - `skipped_reasons` — why some issues were skipped.

### Flow C: Payload dispatch (large/bundled payload)

For large payloads or multi-file bundles:

1. Place ZIP base64 / restore files under `.gptwork/goal-inbox/`.
2. Create a GitHub issue with `gptwork-dispatch` label and payload references
   in the body.
3. The `gptwork-dispatch.yml` workflow runs automatically on issue open/edit.
4. After dispatch, check:
   - Workflow run summary (Actions tab) for `GPTWork Dispatch: Push processed`
     or `GPTWork Dispatch: Skipped`.
   - Issue comment from `github-actions[bot]` confirming dispatch.
   - `runtime_status` / `worker_status` for task state.

### Flow D: Question → Task upgrade

For an existing `gptwork-question` issue that should become a task:

1. Add a task-intake marker (frontmatter, JSON block, or
   `gptwork-task-intake` label).
2. Call `import_task_handoffs(source: "github", dry_run: true)` to preview.
3. Call `import_task_handoffs(source: "github", dry_run: false, apply: true)`
   to execute the conversion.
4. A new task is created linked to the original request.

---


### Flow E: No-result / 429 (quota/rate limit recovery)

When a task completes with `result.tests=null` or `result.summary` indicating
a quota/rate-limit error (e.g., ChatGPT 429, "no-result" diagnostics):

1. **Do not** create a runner downgrade or code-fix task. The issue is temporary
   quota exhaustion, not a system defect.
2. Check current quota status:
   - `runtime_status` → `worker.health` for worker stall warnings.
   - `gptwork_doctor` → diagnostics for any quota-related flags.
3. Wait for quota to restore (typically 1-60 minutes depending on rate limit).
4. After quota is restored, retry the task:
   - If the task is in `waiting_for_repair`: call `request_repair(task_id: "...", origin: "after_quota_restore")`.
   - If the task is `failed`: re-create with `create_task` using the same description.
   - If using GitHub fallback: re-sync with `import_task_handoffs(source: "github", apply: true)`.
5. **Confirm retry succeeded** — check:
   - `get_task(id: "...") → result.tests` is non-null and shows a test count.
   - `result.verification.passed === true`.
   - `result.acceptance_decision === "passed"` or `result.reviewer_decision.passed === true`.

> **Red flag**: If retry also produces `tests=null` / no-result, the issue may
> not be quota-related. File a bug report with the full diagnostics output.

### Flow F: Repair / retry loop

For tasks that failed verification or acceptance:

1. Check `get_task(id: "...")` for repair info:
   - `repair.root_task_id` — original root task (if this is a repair).
   - `repair.repair_attempt` — current attempt number.
   - `repair.max_attempts` — maximum allowed attempts.
   - `repair.retained_worktree` / `repair.retained_branch` — worktree to reuse.
2. If `repair.can_continue === true`: call `request_repair(task_id: "...", max_attempts: 3)`.
3. After repair completes, verify:
   - `result.tests` shows passing tests.
   - `result.verification.passed === true`.
   - `result.acceptance.overall_status === "passed"` or equivalent.
   - `reviewer_decision.passed === true` and `reviewer_decision.blocking_count === 0`.
4. If repair exhausted (`repair.can_continue === false`): task enters
   `waiting_for_review` for manual operator assessment.

### Completion criteria — when is a task really done?

A task is **fully complete** when ALL of the following are true:

| Criterion | Check |
|-----------|-------|
| Status | `task.status === "completed"` |
| Tests present | `result.tests` is non-null and shows pass/fail counts |
| Verification passed | `result.verification.passed === true` |
| No blockers | `result.acceptance_decision === "passed"` or `acceptance_findings` has 0 blockers |
| Reviewer decision | `reviewer_decision.passed === true` and `blocking_count === 0` |
| Commit exists | `result.commit` is a valid commit SHA |
| Clean worktree | Git worktree is clean (no uncommitted changes in result) |

If any criterion is missing, the task is **not ready** for closure and should
remain in `waiting_for_review` for operator evaluation.


## 5. Diagnostics and Sync Output

The `sync_from_github` and `import_task_handoffs` tools return diagnostic
fields that help you understand what happened:

### `sync_from_github` Output

| Field | Type | Meaning |
|-------|------|---------|
| `imported_tasks` | number | Tasks created in this sync cycle |
| `tasks[].id` | string | Created task IDs |
| `tasks[].title` | string | Task titles |
| `tasks[].status` | string | Task status (usually `queued`) |
| `imported_responses` | number | ChatGPT responses imported from issue comments |
| `last_imported_tasks` | number | Cumulative tasks imported since last reset |
| `last_scanned_issue_count` | number | Issues that passed label/title filter |
| `last_raw_api_issue_count` | number | Raw open issues from GitHub API (before filtering) |
| `skipped_reasons` | array | Reasons + details for each skipped issue |

### `import_task_handoffs` Output

| Field | Type | Meaning |
|-------|------|---------|
| `dry_run` | boolean | Whether this was a dry run (no changes committed) |
| `source` | string | Source scanned (`github`, `request`, `inbox`, `all`) |
| `total_imported` | number | Tasks created (0 when dry_run=true) |
| `would_import_count` | number | Tasks that would be created (nonzero when dry_run=true) |
| `total_skipped` | number | Items skipped across all sources |
| `github_tasks` | array | Tasks imported from GitHub issues |
| `request_conversions` | array | Tasks converted from ChatGPT requests |
| `inbox_handoffs` | array | Tasks imported from local inbox |
| `skipped` | array | Skipped items with `reason` and `details` |

### `github_status` Output

| Field | Type | Meaning |
|-------|------|---------|
| `api_sync_enabled` | boolean | Whether API sync is configured and operational |
| `api_repo` | string | Configured GitHub repo |
| `api_token_set` | boolean | Whether an API token is available |
| `last_inbox_imported` | number | Last inbox import count |
| `last_inbox_failed` | number | Last inbox import failures |

---

## 6. Migration Strategy

### Issue #130 (question issue)

Issue #130 was created as a `gptwork-question` issue but contains content
that should be a task. To migrate:

1. Add a task-intake marker to the issue body (frontmatter or JSON block)
   or add the `gptwork-task-intake` label.
2. Call `import_task_handoffs(source: "github", dry_run: true)` to preview.
3. If the output shows the issue as convertible, call
   `import_task_handoffs(source: "github", dry_run: false, apply: true)`.
4. Verify the new task with `get_task`.

### Issue #125 (dispatch bot noise)

Issue #125 (and similar) received a `github-actions[bot]` comment saying
"GPTWork dispatch failed: Could not find a payload reference...". This was
caused by the dispatch workflow (`gptwork-dispatch.yml`) incorrectly treating
a regular `gptwork-task` issue as a payload dispatch.

**Fix applied (commit `41efe0e`)**: The dispatch workflow now skips issues
with only `gptwork-task` label (no `gptwork-dispatch` / `gptwork-payload`
label). Regular task issues no longer receive dispatch failure comments.

**What to do about history**: Existing comments on #125 and similar issues
are historical and safe to leave. They do not affect current or future
processing. The issue itself can be re-synced as a normal task via
`sync_from_github` or `import_task_handoffs` without triggering the
dispatch workflow.

---

## 7. Troubleshooting

| Symptom | Likely Cause | Action | Auto-Fix? |
|---------|-------------|--------|-----------|
| `imported_tasks=0` | No open issues with matching labels/titles | Check labels: issue must have `gptwork-task` or convertible marker. Or run `sync_from_github` first to refresh `knownIssues` cache. | No — fix label |
| `question_label_without_task_intake` | Issue has `gptwork-question` label but no intake marker | Add `<br>gptwork-task-intake` label or body marker (frontmatter/JSON) | No — add marker |
| `duplicate_issue_number` | Issue # already linked to an existing task | Check `get_task` for the existing task; if stale, mark completed or clean up manually | No — manual review |
| `already_imported` | Task ID in body matches an existing task | Already imported; check `get_task` for status | Yes — informational |
| `no_task_intake_marker` | Issue/request lacks `gptwork_intake: task` or `gptwork-task-intake` label | Add intake marker and retry | No — add marker |
| `invalid_task_intake_payload` | Frontmatter/JSON has wrong format or missing required fields | Check frontmatter has `gptwork_intake: task` exactly | No — fix format |
| Dispatch: `no_payload_ref` | Issue has `gptwork-dispatch` label but body lacks ZIP/Restore/Fallback reference | Add payload reference to body (e.g., `ZIP base64: \`path/to/file.zip.b64\``) | No — fix body |
| Dispatch: `no_dispatch_label` | Issue lacks `gptwork-dispatch`/`gptwork-payload` label | Add dispatch label, or use `sync_from_github` for `gptwork-task` issues | No — fix label |
| Dispatch: `payload_not_found` | Payload file path referenced in issue body does not exist | Verify file exists on main branch; path is relative to workspace root | No — commit file first |
| `GitHub token missing` | `GPTWORK_GITHUB_TOKEN` not set | Check `.gptwork/runtime.env` — set `GPTWORK_GITHUB_TOKEN` | No — env config |
| `GPTWORK_MCP_URL missing` | Dispatch bot cannot reach backend | Check workflow secrets: `GPTWORK_MCP_URL` and `GPTWORK_MCP_TOKEN` must be set | No — secret config |
| Tool exists in code but not visible in ChatGPT tool list | Tool mode restriction or server needs restart | Check `GPTWORK_TOOL_MODE` (should be `standard` or higher). Call `tools/list` to verify. Restart if tool was recently added | Yes after restart |
| `sync_from_github` returns error | GitHub API call failed (token expired, rate limit, network) | Check `last_sync_error` field. Verify GitHub token is valid and has repo scope | No — manual check |
| `worker_status` shows no progress | Worker needs a tick or queue is empty | Check `worker.enabled` and `worker.running`. If idle, create and assign a task | No — assign task |

| Symptom | Likely Cause | Action | Auto-Fix? |
|---------|-------------|--------|-----------|
| `runtime_commit_mismatch` | Running commit differs from repo HEAD | Restart GPTWork service: `cd backend && ./bin/restart-mcp.mjs` | Yes after restart |
| `dirty_worktree` | Uncommitted changes in the worktree | Commit or stash changes, then restart or continue | Manual git work |
| `active_lock` | A task holds a repo execution lock | Check `repo_locks.statuses` in `runtime_status`. Wait for lock to release, or force-clear if stale | No — wait or force |
| `waiting_for_review: tests_missing` | Task completed but has no test evidence | Retry task (see Flow E) or request repair | No — retry |
| `waiting_for_review: runtime_restart_required` | Running commit != repo HEAD, changes not active | Restart GPTWork service to pick up latest commit | Yes after restart |
| `waiting_for_review: manual_review` | Repair exhausted or operator decision needed | Check `get_task` for full result, manually assess | No — requires human |
| Tool exists in code but not visible | Tool mode restriction or server needs restart | Check `GPTWORK_TOOL_MODE`. Call `tools/list`. Restart if needed | Yes after restart |

---

## 8. FAQ

**Q: Can I use gptwork-task and gptwork-dispatch together on the same issue?**

No. A single issue should have exactly one role. If you need to dispatch a
payload, use `gptwork-dispatch`. If you need to import a plain text task,
use `gptwork-task`.

**Q: What happens if an issue has both gptwork-task and gptwork-dispatch?**

The dispatch workflow (`gptwork-dispatch.yml`) checks for `gptwork-dispatch`
first. If both labels are present and the body has a payload reference, it
will dispatch the payload. The `sync_from_github` tool will also try to
import the text as a task, potentially creating a duplicate. **Avoid assigning
both labels.**

**Q: How do I know if a sync succeeded?**

Check the `imported_tasks` count in the `sync_from_github` or
`import_task_handoffs` response. If it's 0, check `skipped_reasons` for
details.

**Q: My dispatch workflow failed with a 404. What went wrong?**

The most common cause is `GPTWORK_MCP_URL` pointing to a non-existent
endpoint. Verify the URL is reachable from the GitHub Actions runner.
Also check that `GPTWORK_MCP_TOKEN` matches the backend's expected token.

**Q: Do I need to delete old "GPTWork dispatch failed" comments?**

No. Those comments are historical artifacts from before the dispatch label
fix (commit `41efe0e`). They do not affect current processing. Leave them
in place.

---

## 9. Related Documentation

- [Operations Runbook](operations.md) — Service health, restart protocol,
  lock management, retention cleanup
- [Current Status](current-status.md) — Feature status and known limitations
- [Architecture](architecture.md) — System design overview
- [Setup & Connection](setup-connect.md) — How to connect ChatGPT and Codex
- [README](../README.md) — Project overview and quick start
- [Goal Queue](goal-queue.md) — Goal/task queue execution
- [E2E Acceptance](e2e-acceptance.md) — Test acceptance criteria

---

## Change Log

| Date | Change |
|------|--------|
| 2026-06-26 | Initial version — label taxonomy, issue templates, workflows, migration strategy, troubleshooting |
