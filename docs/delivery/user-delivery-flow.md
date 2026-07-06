# User Delivery Flow

> Complete user journey from queued goal to completed, accepted, integrated delivery.

## Flow Steps

### 1. Create Goal
User submits a request via ChatGPT, Codex CLI, or API. The system creates a goal
with `status=open`, optionally with an encoded payload via `create_encoded_goal`.

### 2. Enqueue Goal
The goal enters the execution queue via `enqueue_goal`. Queue items support:
- Goal dependency (`depends_on_goal_id`) — waits until the referenced goal is terminal-completed
- Task dependency (`depends_on_task_id`) — waits until the referenced task completes or fails
- Auto-start flag (`auto_start`) — enables automatic advancement

### 3. Queue Auto-Advance
The auto-advance tick (`queueAutoAdvanceTick`) runs on every worker cycle:
- Applies nine typed eligibility gates (dependency, acceptance, integration,
  finalizer, repo concurrency, repo lock, dirty worktree)
- Advances the first fully-eligible item
- Creates a git worktree for isolated execution

### 4. Context Bundle
The system builds a bounded context packet (`codex.entry.md` + `context.bundle.md`)
from the goal definition, retrieval store, and relevant prior results.

### 5. Codex Execution
Codex executes the goal in the isolated worktree:
- Writes `result.json` with status, changed_files, commit, verification evidence
- Writes `result.md` with markdown summary
- Commits changes to the worktree branch

### 6. Verification
Deterministic checks run via `verifyTaskCompletion`:
- Syntax and import validation
- Changed-files diff
- Profile-scoped verification (release gate for code changes)
- Noop/readonly tasks skip heavy checks

### 7. Acceptance Gate
The acceptance gate (`acceptance-gate-engine.mjs`) evaluates the result:
- Loads the acceptance contract (from goal, task, or `acceptance.contract.json`)
- Checks all blocking requirements against result evidence
- Produces a closure decision: auto-complete, repair, or review
- Outputs `acceptance.json` artifact

### 8. Integration
For mutating changes, the integration queue serialises ff-only merges:
- Code/config changes require integration (merge or PR)
- Docs-only changes skip integration
- Already-integrated commits (reachable on canonical branch) are detected
  via `delivery-result-recovery`

### 9. Finalizer
The finalizer (`task-finalizer.mjs`) determines the terminal state:
- `completed` — all gates passed, queue may auto-advance
- `waiting_for_repair` — repairable failures, auto-creates repair task
- `waiting_for_review` — non-repairable failures, human attention needed
- `waiting_for_integration` — accepted but not yet integrated
- `failed` / `timed_out` — irrecoverable terminal states

### 10. Unified Decision
A single `UnifiedAcceptanceDecision` is produced and propagated to:
- Goal status update
- Queue propagation (unblock dependants or hold)
- Review packet builder
- Notification service

### 11. Completion
Task completed, worktree cleaned up, dependant queue items unblocked, goal marked
completed. For runtime changes, a safe restart may be required.

## Change-Type Behavior

| Change Type | Integrated | Restart | Terminalization |
|-------------|------------|---------|----------------|
| **Docs-only** | Skipped | Not required | Auto-completes immediately after acceptance |
| **Code/config** | Required (ff-only merge) | Not required | Completes after integration evidence confirmed |
| **Runtime** | Required (ff-only merge) | Required | Holds completion until restart confirmed or waived |

## Verification Commands

- Health: `npm start` → check health endpoint
- Queue: `list_goal_queue` tool
- Status: `gptwork_doctor` tool
- Tests: `npm test`
- Docs check: `npm run check:syntax && npm run check:imports`

## Related Documentation

- [E2E Delivery Workflow](../e2e-acceptance.md) — full pipeline reference with stage details
- [Goal Queue](../goal-queue.md) — queue scheduling, tools, dependency management
- [Queue Auto-Advance](../queue-auto-advance.md) — typed gates, reconciler, runtime conditions
- [Closure and Acceptance Model](../closure-acceptance.md) — acceptance, finalizer, unified decision
- [Task State Machine](task-state-machine.md) — state transitions and terminal states
- [Acceptance and Repair Contract](acceptance-and-repair-contract.md) — profiles, evidence, repair loop
- [Release Gate](release-gate.md) — pre-release checklist
- [Context and Worktree Contract](context-and-worktree-contract.md) — worktree lifecycle, context contracts
- [Multi-Task Delivery Architecture](multi-task-delivery-architecture.md) — component architecture
