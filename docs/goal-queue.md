# Goal Queue Execution

> Implemented: 2026-06-22

## Overview

The goal queue turns "open goal backlog" into a real execution pipeline.
Queue items flow through status states with automatic task creation when dependencies are satisfied.

## Terminology

| Term | Meaning |
|------|---------|
| **Open Goal** | A goal with `status=open`, `task_id=null`, `assignee=""`. It is NOT automatically executed. Only exists as a record of intent. |
| **Queued Goal** | A goal placed in the execution queue via `enqueue_goal`. It gets a `queue_id`, `position`, and `status` in the queue. |
| **Executable Task** | A task with `assignee="codex"` and `status="assigned"`. The Codex worker picks it up automatically. |

## Queue Status Lifecycle

```
Goal enqueued
  → status=waiting
      ↓ (dependency met, repo free, worktree clean)
  → status=ready  → start_next_queued_goal
      ↓ (task created and assigned to Codex)
  → status=running, task_id=xxx
      ↓ (task completes)
  → status=completed
      ↓ (auto_start_next_on_task_completed)
  → (next queue item advances)
```

Other transitions:
- `waiting → blocked` — When dependency is not met or repo is locked or worktree dirty
- `blocked → waiting/ready` — Manually via `update_goal_queue_item`
- `running → failed` — When the task fails
- `* → cancelled` — Via `cancel_goal_queue_item`

## Queue Item Fields

```json
{
  "queue_id": "queue_xxx",
  "goal_id": "goal_xxx",
  "task_id": "task_xxx or null",
  "workspace_id": "hosted-default",
  "repo_id": "github.com/user/repo or empty",
  "position": 1,
  "status": "waiting|ready|running|blocked|completed|failed|cancelled",
  "depends_on_goal_id": "goal_xxx or null",
  "depends_on_task_id": "task_xxx or null",
  "blocked_reason": "why it's blocked",
  "auto_start": true,
  "created_at": "ISO timestamp",
  "updated_at": "ISO timestamp"
}
```

## MCP Tools

| Tool | Mode | Description |
|------|------|-------------|
| `enqueue_goal` | standard, codex, full | Add an open goal to the queue. Supports `depends_on_goal_id` and `depends_on_task_id` for ordering, and `auto_start` for auto-advance. |
| `list_goal_queue` | standard, codex, full, operator | List queue items sorted by position. Filterable by `status`, `workspace_id`, `repo_id`. |
| `get_goal_queue` | standard, codex, full, operator | Get a single queue item by `queue_id`. |
| `start_next_queued_goal` | standard, codex, full | Start the next eligible queue item. Runs dependency, repo lock, and worktree checks. Supports `dry_run=true` for preview. |
| `update_goal_queue_item` | standard, codex, full | Update mutable fields: status, blocked_reason, auto_start, position, dependencies. |
| `cancel_goal_queue_item` | standard, codex, full | Cancel a queue item (only non-running items). |

## CLI Commands

```bash
gptwork queue list [--status <status>]
gptwork queue start-next [--dry-run]
gptwork queue enqueue <goal_id> [--depends-on-goal <gid>] [--depends-on-task <tid>]
gptwork queue cancel <queue_id>
```

## How to Use

### Enqueue an Existing Goal

```bash
# Via CLI
gptwork queue enqueue goal_51da0e55-3395-41b2-8200-fddf6c7045f7

# Via MCP tool (ChatGPT or Codex)
# call enqueue_goal(goal_id="goal_xxx")
```

### Start the Next Queued Goal

```bash
# Preview only (no changes)
gptwork queue start-next --dry-run

# Actually start
gptwork queue start-next
```

### Create a Dependency Chain

```bash
gptwork queue enqueue goal_prereq
gptwork queue enqueue goal_dependent --depends-on-goal goal_prereq
```

### Auto-Start on Task Completion

When final task writeback records an accepted, verified auto-integration completion (`auto_completed_clean` or `auto_completed_with_followups`), the linked goal is completed in the same state mutation as the task and running queue item. Dependency-blocked queue items that were waiting on that goal are reconciled from `blocked` to `ready`, then `autoStartNextOnTaskCompleted` attempts to start the next eligible item.

This is the normal path for accepted integrated Codex work; it does not require manual `complete_task`, `recovery_queue_reconcile`, or `start_next_queued_goal`. Failed, unaccepted, review-required, dirty, or unmerged tasks do not trigger this propagation.

## Repo Concurrency

The queue prevents concurrent execution on the same repository:

1. **Before** creating the task, `start_next_queued_goal` checks for another running queue item with the same `repo_id`.
2. If one exists, the candidate queue item is blocked with a repo concurrency reason.
3. Repo locks and dirty-worktree checks are still enforced by task execution and integration guards; they are not bypassed by queue propagation.
4. After the running item completes and guards are clear, the next queue run can advance.

These checks work alongside the existing per-repository Codex execution lock (`repo_lock_status`/`list_repo_locks`).

## Migration from Open Goals

Existing open goals (Queue 2, Queue 3) are NOT automatically migrated.
To enqueue them safely:

```bash
# Check current task status first
gptwork queue enqueue goal_51da0e55-3395-41b2-8200-fddf6c7045f7
gptwork queue enqueue goal_d11eca32-7bcd-4d9e-ac2d-0405506b0dc7 --depends-on-goal goal_51da0e55-3395-41b2-8200-fddf6c7045f7
```

## Dependencies

Queue items support two dependency types:
- **Goal dependency**: `depends_on_goal_id` — waits until the referenced goal is `completed`
- **Task dependency**: `depends_on_task_id` — waits until the referenced task is `completed` or `failed`

Both are checked before starting a queue item. If unmet, the item transitions to `blocked` with a descriptive reason.

## Tool Mode Security

| Tool | minimal | standard | operator | codex | full |
|------|---------|----------|----------|-------|------|
| enqueue_goal | — | ✓ | — | ✓ | ✓ |
| list_goal_queue | — | ✓ | ✓ | ✓ | ✓ |
| get_goal_queue | — | ✓ | ✓ | ✓ | ✓ |
| start_next_queued_goal | — | ✓ | — | ✓ | ✓ |
| update_goal_queue_item | — | ✓ | — | ✓ | ✓ |
| cancel_goal_queue_item | — | ✓ | — | ✓ | ✓ |

## Tests

```bash
cd backend
node --test test/goal-queue.test.mjs
```
