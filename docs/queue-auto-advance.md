# Queue auto advance

This document describes how the GPTWork execution queue decides which queued
goal to start next and when.  The policy is implemented in
[backend/src/queue-policy.mjs](../backend/src/queue-policy.mjs) and wired into
[backend/src/goal-queue.mjs](../backend/src/goal-queue.mjs).

## Overview

The execution queue (`state.goal_queue`) holds ordered items representing goals
that are waiting to run.  Each item has a status:

```
waiting -> ready -> running -> completed|failed
waiting -> blocked              (dependency not met or repo locked)
blocked -> waiting              (when dependency resolves)
running -> completed|failed
```

The queue is driven forward by:

1. **`startNextQueuedGoal`** — scans eligible items (waiting/ready) in position
   order and starts the first one whose preconditions pass.
2. **`autoStartNextOnTaskCompleted`** — when a task finishes, this hook checks
   for dependent queue items and tries to start them if the completed task
   passed acceptance.

Final task writeback is the durable handoff from acceptance to the queue. When
a linked task reaches accepted auto-completion after verified integration,
writeback marks the task, goal, and running queue item completed in one state
mutation, reconciles blocked queue items that depend on the completed goal, and
then calls the auto-start hook. This avoids requiring manual reconciliation for
the normal accepted/integrated path.

## Queue policy rules

### 1. Dependency terminal-only

A `depends_on_goal` or `depends_on_task` must reach a terminal *completed*
state before the dependent can start.

Goal dependencies use the durable goal status. A completed task for a still-open
goal is not enough; final writeback must close the linked goal before queue
policy treats `depends_on_goal` as satisfied.

| Policy | Description |
|--------|-------------|
| `completed_only` (default) | Only status `"completed"` satisfies the dependency. |
| `terminal_any` | Any terminal state (completed, failed, timed_out, blocked, cancelled) satisfies the dependency. |

### 2. Acceptance gating

If the prerequisite task finished with a status other than `"completed"`
(e.g. failed, timed_out), queue items that depend on that task are blocked.

- A task that did not pass acceptance **must not advance** the queue.
- Items depending on the failing task are marked `blocked` with a clear reason.
- The `start_next_queued_goal` MCP tool reports the acceptance gate result
  in its `checks` array.

### 3. Repo serialisation

Two items for the same repository may not run concurrently.

- When `startNextQueuedGoal` evaluates an item with a `repo_id`, it checks
  whether any other running queue item already claims the same repo.
- If a conflict is found, the candidate is marked `blocked` until the earlier
  item finishes.

### 4. Auto-start preconditions

A queue item is eligible for auto-start **only** when all of the following
pass:

- Dependency satisfied (terminal completed for `completed_only`).
- Acceptance gate passed (prerequisite task is `completed`).
- No repo concurrency conflict (same repo is not already running).

## The `start_next_queued_goal` tool

The MCP tool reports **individual check results** in its return value.
Each check object has the shape:

```json
{
  "check": "dependency|acceptance_gate|repo_concurrency|repo_resolution|execution_guards_deferred",
  "passed": true|false,
  "detail": "human-readable explanation",
  "repo_id": "...",
  "blocking_item_queue_id": "...",
  "blocking_item_goal_id": "..."
}
```

The checks are evaluated in order:

1. `dependency` — is the prerequisite goal/task in the right state?
2. `acceptance_gate` — did the prerequisite task pass acceptance?
3. `repo_concurrency` — is another item already running on the same repo?
4. `repo_resolution` — can the repository path be resolved?
5. `execution_guards_deferred` — repo lock and worktree checks are deferred
   to the execution phase.

## Architecture

```
queue-policy.mjs          (pure policy logic)
    |
    v
goal-queue.mjs            (queue operations, calls policy checks)
    |
    v
goal-queue-tools-group.mjs (MCP tool wrappers)
```

Auto-integration verification is part of the accepted/integrated handoff. Its
JSON reports are generated outside the canonical repository by default whenever
the default workspace root points at that repository. This keeps the canonical
repo clean for the dirty-repo guard that protects queue auto-advance from
integrating on top of untracked runtime artifacts. Deployments that need a
specific report location can set `autoIntegrationReportDir` explicitly.

## Testing

```bash
# Run policy-specific tests
node --test test/queue-policy.test.mjs

# Run queue integration tests
node --test test/goal-queue.test.mjs
```
