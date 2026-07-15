# P0-P2 Productization Closure Plan — 2026-07-15

## Objective

Close all P0/P1/P2 productization chains across the GPTWork codebase, ensuring
every required capability has real code, passing tests, documentation, and E2E
evidence. Ignores security concerns per task constraints.

## Current Snapshot

Many P0 items already ship (AFC1–AFC10, G1–G7 workstream, pipeline gate hardening,
init/onboarding, codex exec hardening, agent execution backends, review state
auto-resolution, retention cleanup). The remaining gaps are in:

- **P0**: Effective Runtime Manifest, managed worker lifecycle hardening,
  spawn/restart/queue/join full E2E closure
- **P1**: Real worktree fanout/join merge, embedding adapter resilience
  (timeout/retry/fallback), code facts generation, run-lineage observability,
  auto retention with budget metrics
- **P2**: Unified action model, schema migrations, unattended/operator-assisted
  handoff, full product metrics, one-click install/health/canary

## Acceptance Contract Requirements

Per acceptance.contract.json:
- backup/restore evidence
- dry-run evidence
- migration apply evidence
- before/after counts
- rollback plan
- All `required_checks`: check:syntax, check:imports, npm test, release:check,
  self-test, deep doctor, git status clean after tests
- `required_outputs`: implementation plan, P0 commits+evidence, P1 commits+evidence,
  P2 commits+evidence, real E2E evidence bundle, updated product docs, final ready verdict

## Phase Structure

### Phase P0 — Foundation Closure

| ID | Item | Status |
|----|------|--------|
| P0.1 | Effective Runtime Manifest module | PLAN |
| P0.2 | Worker lifecycle E2E wiring test | PLAN |
| P0.3 | BLOCKER->NO-GO release gate wiring | PLAN |
| P0.4 | Spawn/restart/repair/queue/join E2E evidence | PLAN |

#### P0.1 — Effective Runtime Manifest

Create `src/effective-manifest.mjs` -- a formal manifest that:
- Aggregates ALL runtime config keys from runtime-config.mjs, runtime.env, process.env
- Shows source precedence per key (process.env > runtime.env > default)
- Exposes as `getEffectiveManifest()` returning structured JSON
- Includes tool mode, worker state, storage config, agent backends
- Has a test file `test/effective-manifest.test.mjs`

Test plan:
1. Returns all expected top-level keys
2. Source precedence: process.env overrides runtime.env
3. Contains all required system config keys
4. Manifest is serializable (JSON.stringify roundtrips)

#### P0.2 — Worker Lifecycle E2E Test

Create `test/worker-lifecycle-e2e.test.mjs` that verifies:
- Worker can be started from gptwork-server.mjs
- Worker health phases: starting -> running -> idle
- Worker queue reconciliation runs
- Worker stops cleanly

#### P0.3 — BLOCKER->NO-GO Wiring

Harden `release-gate.mjs` and `current-blocker-policy.mjs` so that:
- Any BLOCKER-level finding in any gate produces NO-GO verdict
- Ensure release:check cannot pass when blockers exist

#### P0.4 — E2E Evidence

Run the full P0-P5 release gate with evidence capture.

### Phase P1 — Observability & Resilience

| ID | Item | Status |
|----|------|--------|
| P1.1 | Embedding adapter resilience | PLAN |
| P1.2 | Worktree fanout merge/conflict repair | PLAN |
| P1.3 | Run-lineage observability | PLAN |
| P1.4 | Code facts generation | PLAN |
| P1.5 | Auto retention with budget metrics | PLAN |

#### P1.1 — Embedding Adapter Resilience

Create `src/embedding/embedding-adapter.mjs` with:
- `withTimeout(promise, ms)` -- wraps any embedding call with timeout
- `withRetry(fn, options)` -- retry with exponential backoff (maxRetries, baseMs)
- `withFallback(primary, fallback, options)` -- falls back to secondary provider
- `benchmarkAdapter(adapter, iterations)` -- measures latency, throughput, error rate
- `checkpointDigest(content)` -- produces SHA-256 digest of embedding state
- `failClosed(defaultValue)` -- returns default on unrecoverable failure

Test plan:
1. Timeout rejects when operation exceeds limit
2. Retry succeeds after transient failures
3. Retry exhausts maxRetries and throws
4. Fallback returns primary on success, fallback on failure
5. Benchmark returns stats (min, max, avg, errors)
6. Checkpoint digest is deterministic
7. Fail-closed returns default instead of throwing

#### P1.2 — Worktree Fanout Merge/Conflict Repair

Extend existing worktree fanout in `src/orchestration/task-fanout-service.mjs`
with merge/rebase/conflict detection and repair:
- `mergeWorktreeBranch(worktreePath, targetBranch)` -- merges worktree branch
- `rebaseWorktreeBranch(worktreePath, baseBranch)` -- rebases onto base
- `detectMergeConflicts(worktreePath)` -- returns list of conflicted files
- `repairConflict(worktreePath, file, strategy)` -- auto-resolve by strategy

Tests verify each operation with real git worktrees.

#### P1.3 — Run-Lineage Observability

Extend `product_status` and queue metrics to include:
- `run_lineage` -- chain of parent_task_id -> task_id for each running task
- `backpressure` -- queue depth and processing rate
- `shard_distribution` -- across workstreams or role backends

#### P1.4 — Code Facts Generation

Create `src/code-facts.mjs` that:
- Scans `src/` and generates function/class/module index
- Produces structured JSON catalog

#### P1.5 — Auto Retention with Budget Metrics

Harden `worker-maintenance.mjs` to:
- Enforce budget limits (max goals, max tasks, max storage)
- Emit metrics before/after retention runs
- Wire into `product_status` output

### Phase P2 — Operational Readiness

| ID | Item | Status |
|----|------|--------|
| P2.1 | Unified action model | PLAN |
| P2.2 | Schema migrations framework | PLAN |
| P2.3 | Service health/canary/restart recovery | PLAN |
| P2.4 | Unattended/operator-assisted handoff | PLAN |
| P2.5 | Full product metrics query | PLAN |

#### P2.1 — Unified Action Model

Create `src/unified-action-model.mjs` -- a standard interface for all task operations:

Action descriptor: { id, type (start/stop/retry/resume/assisted/approve/apply/repair/dirty_resolve/restart_verify/cleanup), task_id, goal_id, params, timestamp }

Functions:
- `executeAction(action)` -- dispatches to handler by type
- `getActionHistory(taskId)` -- returns actions for a task
- `getAvailableActions(task)` -- returns available action types for current state

Tests verify model creation, dispatch, history, and available actions.

#### P2.2 — Schema Migrations Framework

Create `src/schema-migrations.mjs`:
- `MigrationRegistry` -- register migrations with version, description, up/down
- `runMigrations(state)` -- apply pending migrations
- `rollbackMigration(state, version)` -- revert a migration
- `backupState(state)` -- create backup before migration
- `restoreState(state, backup)` -- restore from backup

#### P2.3 — Service Health/Canary/Restart Recovery

Enhance `cli.mjs` and `runtime-watch-diagnostics.mjs`:
- `health()` -- returns { status, uptime, version, commit }
- `canary()` -- runs smoke health check
- `restartRecovery()` -- verifies server restarts cleanly

#### P2.4 — Unattended/Operator-Assisted Handoff

Create `src/handoff-controller.mjs`:
- Routes `exec` failures to `awaiting_operator` state
- After operator action, returns to unified acceptance path
- TUI takeover for operator-assisted recovery

#### P2.5 — Full Product Metrics

Enhance `product_status` to include:
- System metrics (uptime, version, commit)
- Worker metrics (queue depth, processing rate, error rate)
- Goal metrics (open, completed, failed counts)
- Task metrics (by status distribution)
- Retention metrics (storage used, limit)

## Constraint Compliance

- **TDD per unit**: Each feature gets a test file before implementation
- **Frequent commits**: After each working feature/fix
- **No waiting**: All execution is continuous
- **Backward compatibility**: Existing APIs and tests must not break
- **No hardcoded /home/a9017 paths**: All paths use process.env or config
- **Clean repo after tests**: git status empty after all verifications

## Required Checks Manifest

| Check | Must Pass |
|-------|-----------|
| `npm run check:syntax` | YES |
| `npm run check:imports` | YES |
| `npm test` | YES |
| `npm run release:check` | YES |
| `gptwork_self_test` | YES |
| `gptwork_doctor deep` | YES |
| `git status --porcelain` (empty) | YES |

## Evidence Collection

After each phase:
1. Run all required checks
2. Capture stdout to phase evidence file
3. Record before/after counts
4. Document rollback procedure
5. Commit with structured message

## Rollback Plan

If a phase introduces failures:
1. `git revert <phase-commit>` to undo
2. Run full test suite to verify recovery
3. Document failure mode and retry strategy
4. If phase is partial, land infrastructure separately

## Execution Order

The plan must be executed in strict phase order because later phases depend on
foundation modules from earlier phases:

P0.1 (Effective Manifest) -> P0.2 (Worker E2E) -> P0.3 (BLOCKER->NO-GO) ->
P1.1 (Embedding adapter) -> P1.2 (Worktree fanout) -> P1.3 (Run-lineage) ->
P1.4 (Code facts) -> P1.5 (Auto retention) ->
P2.1 (Unified action model) -> P2.2 (Schema migrations) -> P2.3 (Health) ->
P2.4 (Handoff) -> P2.5 (Full metrics) ->
Final: E2E evidence bundle + doc updates + final verification
