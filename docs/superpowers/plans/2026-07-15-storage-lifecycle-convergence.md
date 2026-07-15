# Storage Lifecycle Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent GPTWork test and execution resources from exhausting `/tmp` or worktree storage while preserving durable task identity.

**Architecture:** Add process-scoped test cleanup, directory-aware `/tmp` scanning and eviction, and an hourly runtime janitor. Reuse existing retention tombstones and safe worktree policies rather than introducing a second state store.

**Tech Stack:** Node.js ESM, `node:test`, `node:fs/promises`, existing GPTWork MCP cleanup and retention services.

## Global Constraints

- Worker remains disabled during implementation and deployment.
- Only explicit GPTWork-owned prefixes are eligible for `/tmp` deletion.
- Unknown, recent, active, dirty, or unmerged resources are preserved.
- Task identity is never hard-deleted.
- Every behavior change follows red-green TDD.

---

### Task 1: Directory-aware temp inventory and cleanup

**Files:**
- Modify: `backend/src/gptwork-tmp.mjs`
- Modify: `backend/src/tool-groups/cleanup-tools-group.mjs`
- Test: `backend/test/gptwork-tmp.test.mjs`
- Test: `backend/test/temp-cleanup.test.mjs`

**Interfaces:**
- Produces: `isOwnedSystemTmpEntry(name)`, `scanSystemTmp({ tmpRoot })`, and `cleanupSystemTmp({ tmpRoot, dryRun, maxAgeMs, maxCount, maxInodes })`.

- [ ] Add failing tests proving allowlisted directories are reported and cleaned while unknown/recent directories survive.
- [ ] Run selected tests and confirm the expected failures.
- [ ] Implement allowlisted directory scanning, bounded inode estimation, and recursive removal.
- [ ] Expose directory and inode metrics from `tmp_status` and `cleanup_tmp`.
- [ ] Run selected tests and commit.

### Task 2: Process-scoped test teardown

**Files:**
- Modify: `backend/test/helpers/run-clean.mjs`
- Modify: `backend/package.json`
- Create: `backend/test/run-clean.test.mjs`

**Interfaces:**
- Produces: a test wrapper that snapshots allowlisted `/tmp` entries and removes only entries created by its child test process.

- [ ] Add a failing integration test whose child creates an allowlisted directory and exits non-zero.
- [ ] Implement snapshot/delta cleanup in a `finally` path with signal forwarding.
- [ ] Route the default `npm test` command through the wrapper.
- [ ] Verify both passing and failing child runs clean their resources, then commit.

### Task 3: Runtime janitor and pressure gate

**Files:**
- Create: `backend/src/storage-janitor-service.mjs`
- Modify: the service startup module identified during implementation.
- Test: `backend/test/storage-janitor-service.test.mjs`

**Interfaces:**
- Produces: `runStorageJanitor(options)` and `startStorageJanitor(options)`; the latter returns a stoppable unref'd timer.

- [ ] Add failing tests for startup run, hourly scheduling, pressure-triggered cleanup, and non-fatal errors.
- [ ] Implement the janitor using `getInodePressure()` and `cleanupSystemTmp()`.
- [ ] Wire it to service startup without enabling the worker.
- [ ] Run tests, syntax/import checks, and commit.

### Task 4: Retention and worktree policy verification

**Files:**
- Modify only if tests expose gaps: `backend/src/retention-service.mjs`
- Test: `backend/test/retention-service.test.mjs`
- Update: `docs/operations.md`

**Interfaces:**
- Consumes existing tombstone and orphan-worktree safety decisions.

- [ ] Add/confirm tests that compacted tasks retain identity and cannot auto-advance.
- [ ] Add/confirm tests that merged clean worktrees are removed while dirty/unmerged worktrees remain.
- [ ] Document TTLs, inode thresholds, dry-run/apply commands, and emergency procedure.
- [ ] Run retention and replay regression suites, then commit.

### Task 5: Deployment and production acceptance

**Files:**
- No source changes expected.

- [ ] Run focused tests, full syntax/import checks, and full test suite.
- [ ] Cherry-pick isolated commits onto current `main` without including unrelated census changes.
- [ ] Push `main`, safely restart to the exact commit, and verify health.
- [ ] Run storage dry-run and apply; verify `/tmp` inode use below 60%.
- [ ] Verify worker disabled, zero runnable tasks, zero active locks/TUI, and zero current blockers.
