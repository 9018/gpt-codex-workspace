# GPTWork Storage Lifecycle Convergence Design

## Problem

GPTWork retains durable task identity correctly, but ephemeral execution resources do not share one lifecycle contract. Test suites create top-level `/tmp` directories through `mkdtemp()` and many suites do not remove them. The existing cleanup service scans only files with two prefixes, so more than 100,000 test directories accumulated and consumed 87% of tmpfs inodes. Historical Goal artifacts and Git worktrees also remain longer than their operational value.

## Product outcome

GPTWork must keep durable identity and acceptance evidence while aggressively reclaiming ephemeral resources. Cleanup must never revive historical tasks, delete active work, or rely on unsafe wildcard deletion.

## Architecture

### 1. Process-scoped test cleanup

All standard backend test entry points run through `backend/test/helpers/run-clean.mjs`. Before spawning `node --test`, the wrapper snapshots GPTWork-owned top-level `/tmp` entries. After the child exits or receives a termination signal, it removes only entries created after the snapshot. This gives deterministic cleanup even when tests fail.

### 2. Directory-aware system temp lifecycle

`gptwork-tmp.mjs` owns a strict allowlist of GPTWork test prefixes. `scanSystemTmp()` reports both files and directories, including entry count and estimated inode count. `cleanupSystemTmp()` removes only allowlisted entries that exceed TTL/count/inode budgets. Unknown `/tmp` entries are never touched.

### 3. Runtime storage janitor

A small janitor runs once at service startup and then hourly. It performs directory-aware `/tmp` cleanup only when entries are older than two hours or inode use exceeds 75%. At 85% inode use it records a critical diagnostic. The timer is unref'd and failures are non-fatal.

### 4. Historical state and artifacts

Task identities remain compact tombstones forever. Goal directories older than seven days are archived. Intermediate execution artifacts use bounded retention; final result, acceptance decision, remote identity, repair lineage, and integration commit remain durable.

### 5. Worktree lifecycle

Active/review/repair/integration worktrees are protected. Clean worktrees whose branch is merged into canonical main are removed immediately. Dirty or unmerged terminal worktrees are archived as metadata plus patch/bundle before removal. Unknown provenance remains protected.

## Safety invariants

- Never remove an entry outside the explicit GPTWork test prefix allowlist.
- Never remove a temp entry created before the current test wrapper started unless it exceeds janitor TTL.
- Never remove active Task, Goal, lock, TUI, worktree, or queue resources.
- Never hard-delete canonical Task identity.
- Cleanup is idempotent and dry-run capable.
- Worker remains disabled throughout migration and verification.

## Acceptance criteria

1. A failing test process leaves no newly-created allowlisted `/tmp` directories.
2. `scanSystemTmp()` reports allowlisted directories and inode estimates.
3. `cleanupSystemTmp()` deletes aged allowlisted directories but preserves recent and unknown directories.
4. Runtime janitor starts without blocking service startup and exposes its last result in diagnostics/logs.
5. Existing temp, retention, queue, replay-protection, and worktree tests pass.
6. Production `/tmp` inode use remains below 60% after apply.
7. No runnable task, lock, TUI, or queue item is created during cleanup.
