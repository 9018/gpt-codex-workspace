# G2: Codex TUI in Task Worktree

**Status:** Implemented + Verified
**Workstream:** ws_gptwork_tui_productization_20260711
**Root Goal:** goal_48d055ee-82b6-415b-8d98-65cb7662aaaf
**Depends on:** G1 (Goal goal_4de62df1-b3d4-402d-94cb-903f05e2352a)

## Summary

Previously, `codex_tui_start_goal` ran the Codex TUI session in the canonical
repository path (`canonical_repo_path`). This meant that:

- All TUI sessions shared the same directory, risking cross-task state leaks.
- Git operations inside the TUI could interfere with the canonical repo.
- Locking was on the canonical repo root.

**G2 fixes this** by introducing an isolated per-task git worktree for each TUI
execution. The full startup flow becomes:

```
resolve plan → materialize worktree → verify worktree → cwd=worktree_path → create execution → start TUI
```

## Architecture

### Worktree Execution Flow

```
┌─────────────────────┐
│ 1. resolve plan     │ ← resolveTaskRepositoryPlan (no git mutation)
│     (no git write)  │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 2. materialize wt   │ ← materializeTaskWorktree (git worktree add)
│     (git worktree)   │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 3. verify worktree  │ ← verifyTaskWorktree (path, git, branch)
│                     │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 4. cwd = worktree   │ ← cwd = task_worktree_path (not canonical)
│     path            │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 5. acquire lock     │ ← on worktree path, not canonical repo
│     on worktree     │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 6. create execution │ ← execution store record
│     record          │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 7. start TUI        │ ← within worktree (cwd = worktree_path)
│     in worktree     │
└─────────────────────┘
```

### Key Design Decisions

1. **Phase separation between plan and materialization.**  
   `resolveTaskRepositoryPlan` never writes to git. Only `materializeTaskWorktree`
   performs `git worktree add`. This keeps the plan safe for queue and dry-run
   contexts.

2. **Task worktree lives under `.gptwork/worktrees/<repo_id>/<task_id>`.**  
   Each task gets its own isolated worktree at:
   ```
   <workspaceRoot>/.gptwork/worktrees/<sanitized_repo_id>/<sanitized_task_id>
   ```

3. **Locks are on the worktree path, not the canonical repo root.**  
   `acquireRepoLock` is called with the worktree path. This prevents
   cross-task lock contention on the canonical repo.

4. **Execution records persist worktree metadata.**  
   Each execution record stores `workstream_id`, `goal_id`, `task_id`,
   `worktree_path`, `branch`, `base_commit`, `head_commit`, `session_id`,
   and optional `codex_thread_id`. Records are stored at:
   ```
   <workspaceRoot>/.gptwork/executions/<execution_id>.json
   ```

5. **Completion is checked from the worktree, not the canonical repo.**  
   `collectCodexTuiCompletion` reads result files and git status from the
   session's `cwd` (the task worktree path).

## Files

### New Files

| File | Purpose |
|------|---------|
| `backend/src/executions/execution-store.mjs` | Durable storage for execution records |
| `backend/src/executions/execution-service.mjs` | Orchestrates worktree execution flow |
| `backend/test/codex-tui-task-worktree.test.mjs` | Tests TUI startup uses task_worktree_path as cwd |
| `backend/test/execution-service.test.mjs` | Tests execution service flow |

### Modified Files

| File | Change |
|------|--------|
| `backend/src/tool-groups/codex-tui-tools-group.mjs` | `startGoalHandler` now materializes worktree, uses worktree_path as cwd, locks on worktree path |
| `backend/src/codex-tui-session-store.mjs` | Added `workstream_id`, `worktree_path`, `branch`, `base_commit`, `head_commit`, `codex_thread_id` fields |
| `backend/src/codex-tui-completion-collector.mjs` | Checks result files and git status from session's cwd (worktree path) |
| `backend/test/codex-tui-tools-group.test.mjs` | Extended with worktree-based execution tests |
| `backend/test/task-worktree-manager.test.mjs` | Extended with worktree-based TUI execution tests |
| `backend/test/task-repo-resolution.test.mjs` | Extended with worktree lifecycle tests |

## Behavior

### Startup Behavior

- `codex_tui_start_goal` now:
  1. Resolves the repo plan via `resolveTaskRepositoryPlan`
  2. Materializes the worktree via `materializeTaskWorktree`
  3. Verifies the worktree is a valid git checkout
  4. Sets `cwd` to `task_worktree_path`
  5. Locks on the worktree path
  6. Creates an execution record
  7. Starts the TUI session inside the worktree

- Return value includes:
  - `session_id`, `task_id`, `goal_id`
  - `cwd` (task worktree path)
  - `worktree_path`, `canonical_repo_path`
  - `branch`, `execution_id`
  - `status`

### Lock Behavior

- Lock path changed from `canonical_repo_path` → `task_worktree_path`
- Lock release also operates on the worktree path
- Each task acquires a lock on its own worktree, eliminating cross-task lock contention

### Completion Collection

- `collectCodexTuiCompletion` now reads session record to get `cwd`
- Checks `result.json` and `result.md` from `cwd` (worktree path)
- Git status is from the worktree, not canonical repo

### Session Store Fields

Session records now support:

```json
{
  "workstream_id": "ws_...",
  "worktree_path": "<workspace>/.gptwork/worktrees/<repo>/<task>",
  "branch": "gptwork/task/<task>",
  "base_commit": "abc123...",
  "head_commit": "def456...",
  "codex_thread_id": null
}
```

### Execution Store Fields

Execution records contain:

```json
{
  "id": "exec_task_1",
  "workstream_id": "ws_...",
  "goal_id": "goal_...",
  "task_id": "task_...",
  "worktree_path": "<path>",
  "branch": "gptwork/task/<task>",
  "base_commit": "abc123...",
  "head_commit": "def456...",
  "session_id": "session_...",
  "codex_thread_id": null,
  "status": "created|running|completed|no_result",
  "created_at": "...",
  "updated_at": "...",
  "metadata": {}
}
```

## Isolation Evidence

Two tasks started concurrently get distinct worktree paths and distinct cwds:

| Property | Task Alpha | Task Beta |
|----------|-----------|-----------|
| cwd | `.../worktrees/test-repo/task_alpha` | `.../worktrees/test-repo/task_beta` |
| Branch | `gptwork/task/task_alpha` | `gptwork/task/task_beta` |
| Lock path | `.../worktrees/test-repo/task_alpha` | `.../worktrees/test-repo/task_beta` |
| Canonical repo | Clean | Clean |

Verified by test `G2-3: two tasks get distinct worktree paths and cwds`.

## Compatibility

- Backward compatible: all existing tests pass.
- No migration needed: existing session records continue to work.
- The `worktree_lifecycle` field in repo resolution plans is unchanged.
- The `enableTaskWorktrees: false` config option preserves legacy behavior.

## Migration Notes

- `codex_tui_start_goal` now requires `materializeTaskWorktree` to be available.
  The injectable `materializeTaskWorktreeFn` parameter was added to
  `createCodexTuiToolsGroup`.
- The returned `cwd` is now the worktree path, not the canonical repo path.
  Callers that relied on `cwd` being the canonical repo must update.
- Lock path changed to the worktree; any external lock watchers must adjust.

## Repair Verification

**Attempt 1 (goal_7939b7b1)** — repaired `changed_files_mismatch` finding.

### Root Cause

The previous execution (goal_7e9c6bfb) correctly committed all nine changed files
in commit 8721310, but its result.json used path `backend/src/codex-tui-tools-group.mjs`
(no `tool-groups/` prefix). The actual file lives at
`backend/src/tool-groups/codex-tui-tools-group.mjs`. The acceptance agent's
`changed_files_mismatch` check found zero matches for the wrong path and flagged
every entry as missing.

### Verification

| Check | Result |
|-------|--------|
| All nine files exist in git HEAD | ✓ |
| `backend/src/tool-groups/codex-tui-tools-group.mjs` (correct path) | ✓ |
| `execution-service.test.mjs` — 7 tests | 7/7 pass |
| `codex-tui-task-worktree.test.mjs` — 4 tests | 4/4 pass |
| `codex-tui-tools-group.test.mjs` — 8 tests | 8/8 pass |
| Two tasks get distinct worktree paths and cwds | ✓ (G2-3) |
| cwd = task_worktree_path, not canonical repo | ✓ (G2-1) |
| Git diff matches declared changed files | ✓ |

### Git History

- `8721310` — G2: Codex TUI executes in isolated task worktree (original implementation)
- `HEAD` — latest commit from this repair attempt (verification + docs update)
