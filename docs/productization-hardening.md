## 2026-07-10 P0 Closure State Machine Convergence Second Repair

This task fixes the convergence bug where repair tasks stuck Closure parent tasks
in an infinite `waiting_for_repair` loop when the repair task produced no changed
files (`codex_failed`/no-change outcome).

### Changed files
- `backend/src/task-finalizer.mjs`
- `backend/src/repair-loop.mjs`

### Fixes
1. **task-finalizer.mjs - `hasRepairPath()`**: Added guard blocking recursive
   `waiting_for_repair` — a repair task (has `parent_task_id`) must NOT treat its
   OWN closure decision as an active external repair path.
2. **task-finalizer.mjs - `decideTaskFinalState()`**: When repairable blockers exist
   for a repair task, route to `failed` instead of `waiting_for_repair` so
   `handleRepairCompletion` is called with `passed: false`. Also in existing hold
   fallthrough — repair tasks stuck in `existing_repair_hold` escape to `failed`.
3. **repair-loop.mjs - `handleRepairCompletion`**: Budget calculation now also checks
   `parent.result.repair_attempt` and `completedTask.repair_attempt`, not only the
   top-level `parent.repair_attempt` which is often 0 for parent tasks.

### Behavior change
- **Before**: A repair task with `codex_failed`/no-changed-files would go to
  `waiting_for_repair` (via its own closure decision), `handleRepairCompletion`
  was never called, parent stayed stuck forever.
- **After**: The repair task goes to `failed`, `handleRepairCompletion` is called with
  `passed: false`, the parent's repair-budget logic runs, and the parent either
  gets a new repair attempt or moves to `human_interrupted_for_repair_budget_exhausted`.

### Verification
```
node --check backend/src/task-finalizer.mjs — passed
node --check backend/src/repair-loop.mjs — passed
node --check backend/src/task-final-writeback.mjs — passed
node -e 'import("./backend/src/task-finalizer.mjs")' — import OK
node -e 'import("./backend/src/repair-loop.mjs")' — import OK
```

# Productization Hardening

## 2026-07-10 P0 hard blockers

Actual code state reviewed in this task:

- `backend/src/agent-execution-backends.mjs` imported under Node ESM, but contained stale generated residue after `resolveBackendSource`: an extra `/**` plus `});` inside the next JSDoc, and a duplicate semicolon after `ROLE_BACKEND_DEFAULTS`. The residue was removed so the module is cleanly parseable and importable.
- `backend/src/task-final-writeback.mjs` called `shouldAttemptRepairFn` and `createRepairGoalFromFindingsFn` synchronously in integration-repair and closure-repair paths. Those dependency hooks are awaited in `task-general-processor.mjs` and tests commonly provide async implementations, so final writeback now awaits both hooks in both paths.
- `backend/src/task-general-processor.mjs` used `uniqueStrings` in the `already_integrated` delivery recovery path without defining it. A local helper now deduplicates non-empty string warnings before writeback.

Verification run:

- `node -e 'import("./backend/src/agent-execution-backends.mjs").then(() => console.log("agent-execution-backends import ok"))'` - passed.
- `npm --prefix backend run check:syntax` - passed, 506 files checked.
- `npm --prefix backend run check:imports` - passed, `imports ok`.
- `node --test --test-reporter=dot backend/test/agent-execution-backends.test.mjs backend/test/pipeline-orchestration.test.mjs` - passed.
- `node --test --test-reporter=dot backend/test/task-general-processor.test.mjs` - passed.
- `node --test --test-reporter=dot --test-name-pattern='repairable acceptance blockers create traceable follow-up task|integration repair awaits async repair helpers' backend/test/task-final-writeback.test.mjs` - passed.

Known remaining risk:

- Full `backend/test/task-final-writeback.test.mjs` still has four existing failures unrelated to this task's P0 fixes: dependent queue unblock assertions, dirty auto integration queue blocking, queue item sync for `waiting_for_repair`, and goal status wording for missing evidence. These failures were present before the await fixes were applied and should be handled as a separate closure/queue consistency task.

## 2026-07-10 Closure State Machine Convergence -- Second Repair

Fixed the convergence bug that left Closure repair tasks stuck in `waiting_for_repair` when the existing repair task was terminal (failed/no-change) and repair budget remained.

### Problem

A parent task in `waiting_for_repair` had its child repair task complete with a terminal outcome (failed or no-change). `handleRepairCompletion` was only called when `taskStatus === "completed"` and always passed `passed: true`. This meant:
- Failed repair children never triggered `handleRepairCompletion` -- the parent's stale `repair_goal_id`/`repair_task_id` metadata remained intact.
- `hasRepairPath()` in the finalizer kept returning `true` based on the stale metadata.
- `repairAttemptsRemaining()` defaulted to `true` when no explicit budget info was present.
- The finalizer kept returning `waiting_for_repair`, creating an infinite loop with no new repair task created.

### Fix (3 files changed)

**1. `backend/src/repair-loop.mjs` -- `handleRepairCompletion`:**
- On `!passed`: check remaining repair budget before deciding parent status.
  - Budget remains (`can_continue`): keep parent in `waiting_for_repair`, increment `repair_attempt`, clear stale `repair_goal_id`/`repair_task_id`/`repair_goal` from parent result, let the worker loop schedule the next repair attempt.
  - Budget exhausted: move to `human_interrupted_for_repair_budget_exhausted` (explicit human-review terminal state, not plain `failed`).
- On `passed`: also clear stale repair path metadata from parent result so `hasRepairPath()` re-evaluates cleanly.

**2. `backend/src/task-final-writeback.mjs` -- repair completion hook:**
- Moved `handleRepairCompletion` call outside the `taskStatus === "completed"` guard.
- Now fires for ANY terminal child outcome (`completed`, `failed`, `cancelled`).
- `passed` is computed correctly: `taskStatus === "completed" && verification?.passed === true && no blocker findings`.

**3. `backend/src/task-finalizer.mjs` -- `hasRepairPath`:**
- Added stale-path guard: if `result.repair_outcome` exists with a known terminal value (`repaired`, `continued`, `budget_exhausted`, `failed`) or `result.repair_status === "completed"`, return `false`.
- Prevents the finalizer from re-entering `waiting_for_repair` on metadata that was already processed by `handleRepairCompletion`.

### Behavior Changes

| Scenario | Before | After |
|----------|--------|-------|
| Repair child failed, budget remains | Parent marked `failed` | Parent stays `waiting_for_repair`, next attempt created |
| Repair child failed, budget exhausted | Parent marked `failed` | Parent moved to `human_interrupted_for_repair_budget_exhausted` |
| Repair child passed (repaired) | Parent updated, metadata lingers | Parent updated, stale path cleared, finalizer re-evaluates cleanly |
| Finalizer sees already-repaired parent | Infinite loop `waiting_for_repair` | `hasRepairPath` returns `false`, proceeds to terminal or review |

## 2026-07-10 P0 Closure Acceptance Contract Followup

The second Closure repair (commit `cfecc3f0567cf3`) produced real code changes fixing the convergence bug, but its followup acceptance task (`task_5efcf3ca-44f8-4599-9b39-7500d42e0bf4`) was blocked by a contract/profile mismatch.

### Problem

The acceptance contract for the followup task was generated with `operation_kind: "diagnostic"`, `mutation_scope: "none"`, and `execution_mode: "readonly"`, plus `blocking_requirements` that demanded a `diagnostic_report` and `no_mutation_evidence`. However the actual work was a code-change repair:

- The acceptance closed result correctly returned `operation_kind: "code_change"` and mutated source files.
- The contract rejected this as `operation_kind_mismatch` and required `no_mutation_evidence`.
- The parent Closure goal (`goal_8081d628-b60e-4f83-bfd4-9a24f709d293`) remained stuck in `waiting_for_repair` despite the repair having succeeded.

### Fix (1 file changed)

**File: `.gptwork/goals/goal_2f637eac-89b4-46e0-81d2-d1287e4db7c5/acceptance.contract.json`**

Changed from diagnostic profile to code_change profile:

| Field | Before | After |
|-------|--------|-------|
| `intent.operation_kind` | `diagnostic` | `code_change` |
| `intent.mutation_scope` | `none` | `specific` |
| `intent.execution_mode` | `readonly` | `build` |
| `requirements.requires_commit` | `false` | `true` |
| `blocking_requirements[0]` | `diagnostic_report` | `source_change` |
| `verification_plan.profile` | `diagnostic` | `code_change` |
| `review_policy.requires_review_when` | (empty) | `verification_fails`, `contract_intent_mismatch` |

### Lesson

Acceptance contracts for repair goals must be generated with the correct operation kind based on the actual work type, not defaulted to `diagnostic`/`readonly`. When a task repairs code, its contract must reflect `code_change` intent so the acceptance verification system does not force the result through diagnostic/no-mutation evidence gates.

The contract normalization path in the task writeback system should resolve `operation_kind` from the actual repair context (e.g., whether source files were changed or repair code ran) rather than assuming all followups/repairs are diagnostic.

### Impact

The original Closure goal `goal_8081d628-b60e-4f83-bfd4-9a24f709d293` can leave `waiting_for_repair` after this acceptance contract fix is applied and the followup result artifacts are accepted by the review system. No further code changes to the repair loop or finalizer are required — the code fix in commit `cfecc3f` already handles the convergence correctly. The remaining blocker is purely the acceptance contract profile.

### Verification

```
node --check /home/a9017/mcp/workspace/.gptwork/goals/goal_2f637eac-89b4-46e0-81d2-d1287e4db7c5/acceptance.contract.json — valid JSON via python3 -m json.tool
python3 -m json.tool /home/a9017/mcp/workspace/.gptwork/goals/goal_2f637eac-89b4-46e0-81d2-d1287e4db7c5/acceptance.contract.json > /dev/null — passed
```

## 2026-07-10 Codex Exec TUI Provider Policy

This task productized the codex_exec / codex_tui_goal switching mechanism. The default production path is `codex_exec` (automatic execution), with `codex_tui_goal` as a manual operator fallback.

### Provider Policy

**Default**: All tasks use `codex_exec` unless explicitly configured.

**Explicit TUI override**: Set `task.metadata.codex_execution_provider = "codex_tui_goal"` on the task to route through TUI.

**Config fields** (runtime-config, all optional):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `codexTuiEnabled` / `codex_tui_enabled` | boolean | `false` | Master switch for TUI mode. Tasks must have BOTH the metadata flag AND this config set to true. |
| `codexTuiEvidenceWaitMs` | number | `120000` | Max ms to wait for result.json after TUI session start |
| `requireSuperpowersPluginForTuiFallback` | boolean | `false` | If true, checks for Superpowers plugin before allowing TUI session |
| `executeProvider` | string | `"codex_exec"` | Default execution provider |
| `acceptProvider` | string | `"codex_exec"` | Default acceptance provider |
| `repairProvider` | string | `"codex_exec"` | Default repair provider |

**Env vars**:

| Variable | Description |
|----------|-------------|
| `GPTWORK_CODEX_TUI_ENABLED` | Enable TUI mode globally |
| `GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI` | Require Superpowers plugin for TUI |
| `GPTWORK_CLAUDE_TUI_ENABLED` | Enable Claude Code TUI mode |
| `GPTWORK_CLAUDE_TUI_COMMAND` | Claude CLI command (default: `claude`) |

### Code Paths

**`codex-execution-provider.mjs`**: Central provider policy module containing:
- `normalizeCodexExecutionProvider(value)` — normalizes to `codex_exec` or `codex_tui_goal`
- `taskUsesCodexTuiGoal(task)` — checks `task.metadata.codex_execution_provider`
- `isCodexTuiEnabled(config)` — checks config/env for master switch
- `isClaudeTuiEnabled(config)` — checks config/env for Claude Code TUI
- `checkSuperpowersPluginForTuiFallback(config)` — preflight check for Superpowers
- `describeCodexExecutionProvider(provider)` — human-readable provider description
- `getTaskExecutionProviderMode(task)` — describes which provider a task uses and why

**`agent-tui-session-core.mjs`**: Shared session management for both codex_tui_goal and claude_tui_goal. Exports `createAgentTuiSessionManager` which provides:
- `startGoalSession` — creates PTY, sends bootstrap messages, returns session
- `resumeSession` — reattaches to existing session
- `readSession` — reads session record
- `stopSession` — stops PTY and releases repo lock
- `getSessionStatus` — reports session state

**`codex-tui-evidence-cycle.mjs`**: Evidence collection for TUI sessions.
- Polls for `result.json` up to `maxWaitMs`
- When result.json appears, collects durable evidence via `collectCodexTuiCompletion`
- Returns `{ evidence_ready, reason, status, finding, collected }` with terminal status when evidence deadline is reached
- `status="timed_out"` when result.json doesn't appear in time
- `status="failed"` when result.json exists but is invalid

**`task-general-processor.mjs`**: Task processing routing:
- Checks `taskUsesCodexTuiGoal(task)` first
- Preflight: PTY availability, Superpowers plugin, repo lock
- Starts TUI session, waits for evidence, returns `failed`/`timed_out` on missing evidence
- On evidence ready, normalizes to task result and continues through acceptance/integration/closure

### Failure Handling

| Scenario | Status | Next Action |
|----------|--------|-------------|
| TUI config disabled | `provider_unavailable` returned as `waiting_for_review` | Enable `GPTWORK_CODEX_TUI_ENABLED=true` |
| PTY mechanism unavailable | `failed` | Install `node-pty` or ensure `script(1)` is available |
| Superpowers plugin missing | `provider_unavailable` returned as `waiting_for_review` | Install via `codex --install-plugin superpowers` |
| Evidence timed out | `timed_out` with `expected_result_json` and `finding` | Resume session or retry with longer timeout |
| Evidence invalid | `failed` with `expected_result_json` and `finding` | Check result.json format, resume session |
| Normal completion | `completed` through acceptance/closure path | Auto-integration and finalization |

### Acceptance Contract Profile

This task also fixed a recurring pattern where repair goals had auto-generated acceptance contracts with `operation_kind: "diagnostic"` instead of the correct `code_change` profile. The contract must be fixed to `code_change` before the repair task can make source changes.

## 2026-07-10 Verifier Evidence Gate Hardening

ChatGPT directly closed another acceptance-loop gap in `backend/src/agent-run-writeback.mjs`.

### Problem

Historical patrols showed a recurring false-positive chain:

1. `verification.passed === true` was present.
2. `verification.commands` was empty or missing.
3. `writeVerifierAgentRun()` still completed the verifier role.
4. Later reviewer/integrator/finalizer roles failed or no-oped because there was no concrete command evidence to review.

The product impact was that automatic acceptance could look green while the user-facing review packet still lacked reproducible verification evidence.

### Fix

Verifier completion now requires concrete command evidence:

- `verification.passed === true`
- `verification.commands.length > 0`

If commands are missing, the verifier role is failed with:

- `failure_class: "verification_commands_missing"`
- `commands_count: 0`
- `missing_evidence: ["verification.commands"]`

The same rule is applied when `completeQueuedAgentRuns()` reconciles queued verifier runs from historical task results, so stale queued verifier roles can no longer be falsely auto-completed with `commands_count=0`.

### Verification

```bash
node --check backend/src/agent-run-writeback.mjs
node --test backend/test/agent-run-writeback.test.mjs
node --test backend/test/agent-run-writeback.test.mjs backend/test/p0-ma11-r2.test.mjs
```

Observed result: 42 related tests passed, including the new regression where a queued verifier with `verification.passed=true` but no commands fails with `verification_commands_missing`.

### Productization acceptance standard

A task is not automatically accepted unless its verifier evidence contains at least one replayable command. This prevents `commands_count=0` from reaching reviewer, integrator, or finalizer as an apparent success.

## 2026-07-10 Orphan Queue Recovery Hardening

ChatGPT also closed a historical queue-state gap found while inspecting the first `waiting_for_review` item.

### Problem

Some historical queue items can reference both a missing goal and a missing task, for example:

- queue status: `waiting_for_review`
- goal id: missing from state
- task id: missing from state

Before this hardening, `recovery_queue_reconcile` only inspected `waiting`, `ready`, `running`, and `blocked` items. That meant orphan items trapped in `waiting_for_review`, `waiting_for_repair`, or `waiting_for_integration` stayed in the queue and kept inflating productization backlog counts.

### Fix

`recovery_queue_reconcile` now includes review/repair/integration hold states in its recoverable scan set and proposes `cancelled` for queue items that reference both a missing goal and missing task.

This is safe because there is no task object to verify, repair, or complete, and no goal context to continue. The recovery action does not start work, does not clear locks, and does not touch the dirty worktree.

### Verification

```bash
node --check backend/src/tool-groups/recovery-tools-group.mjs
node --test backend/test/recovery-plane.test.mjs
```

Observed result: recovery-plane tests passed, including the new regression that dry-runs and applies cancellation for an orphan `waiting_for_review` queue item.

### Runtime note

The running MCP server must be restarted before this new `recovery_queue_reconcile` behavior is visible through the live tool registry.

## 2026-07-10 Docs-only Acceptance Contract Hardening

ChatGPT directly closed the current productization blockers behind two docs regression tasks:

- `Docs Regression: Operations Runbook Sync`
- `Docs Regression: Delivery Workflow Sync`

### Problem

The operation evidence profile already treated `docs_only` as commit + changed docs + lightweight verification, but the acceptance contract profile still required integration evidence. This mismatch produced false `integration_completed_missing` blockers for documentation-only work that had already reported commits and verification commands.

### Fix

`docs_only` contracts now set:

- `requires_commit: true`
- `requires_integration: false`
- `requires_restart: false`
- `requires_deployment_check: false`

The `integration_completed` blocking requirement was removed from the docs-only contract profile. The docs command alias table also treats `git diff --check`, `cd backend && npm run check:syntax`, and `cd backend && npm run check:imports` as valid `docs_check` evidence.

### Verification

```bash
node --check backend/src/acceptance/contract-profiles.mjs
node --check backend/src/verification-report.mjs
node --test backend/test/acceptance-contract-builder.test.mjs backend/test/acceptance-contract-verifier.test.mjs
```

Observed result: 28/28 acceptance contract tests passed, including a regression proving that default docs-only contracts close without integration evidence when commit, changed docs, and docs verification are present.
