# Real Worktree And TUI Terminal Closure Implementation Plan

> **For agentic workers:** Follow red-green TDD and persist both outputs in the goal state directory.

**Goal:** Ensure every worker and repair execution uses the existing isolated task-worktree lifecycle, and ensure every Codex TUI PTY terminal path writes durable terminal evidence and releases its repository lock exactly once at the session boundary.

**Architecture:** Keep `task-worktree-manager` as the sole worktree creator through `task-repo-resolution`. Move worker TUI startup behind successful worktree materialization and remove legacy-mode bypasses. Extend the PTY adapter with a normalized one-shot exit callback, then route spontaneous exit, explicit stop, and spawn failure through one idempotent session terminalizer that preserves valid result evidence, writes fail-closed evidence when missing, and releases the task lock.

**Tech Stack:** Node.js ESM, `node:test`, existing GPTWork task worktree, TUI session store, result contract, and repo-lock services.

## Constraints

- Do not modify, reset, or stash the existing context-index changes.
- Do not create a second worktree manager or derive worktrees outside `task-repo-resolution`.
- Do not fall back to the canonical repository for worker or repair execution.
- Persist exact RED and GREEN command output under the encoded goal directory.

### Task 1: Fail-closed worker and repair repository routing

**Files:**
- Modify: `backend/src/task-general-processor.mjs`
- Modify: `backend/src/codex-worker-runner.mjs`
- Test: `backend/test/task-general-processor.test.mjs`
- Test: `backend/test/codex-tui-provider-routing.test.mjs`
- Test: `backend/test/codex-worker-runner-smoke.test.mjs`

- [ ] Add failing tests proving `full` repair tasks materialize and execute in the task worktree.
- [ ] Add a failing TUI routing test proving startup receives the task worktree cwd, never canonical cwd.
- [ ] Add a failing integration-retry test proving a missing task worktree does not fall back to canonical.
- [ ] Run focused tests and persist RED output.
- [ ] Make worktree materialization mandatory for executable worker paths and fail closed when unavailable.
- [ ] Run focused tests to GREEN.

### Task 2: Normalize PTY terminal notifications

**Files:**
- Modify: `backend/src/codex-tui-pty-adapter.mjs`
- Test: `backend/test/codex-tui-pty-adapter.test.mjs`

- [ ] Add failing tests for node-pty exit and script error/exit/close convergence.
- [ ] Expose a normalized one-shot `onExit` callback from both adapters.
- [ ] Verify duplicate process events invoke the callback once.

### Task 3: Idempotent TUI session terminalization

**Files:**
- Modify: `backend/src/codex-tui-session-manager.mjs`
- Test: `backend/test/codex-tui-session-manager.test.mjs`

- [ ] Add failing tests for zero exit, nonzero exit, signal exit, explicit stop, and spawn failure.
- [ ] Assert exactly one durable terminal event per session.
- [ ] Assert an existing terminal `result.json` is preserved.
- [ ] Assert missing evidence becomes a contract-valid failed/timed-out `result.json`.
- [ ] Assert task lock release is invoked idempotently for every terminal path.
- [ ] Implement one terminalizer shared by exit callbacks, stop, and spawn failure.

### Task 4: Verification and real canary

**Files:**
- Write evidence only under the encoded goal directory.

- [ ] Run focused regression tests and persist GREEN output.
- [ ] Run `npm run check:syntax`, `npm run check:imports`, `npm run release:tui-first-loop-gate`, and `git diff --check` from `backend` where applicable.
- [ ] Run a minimal real Codex TUI canary in a disposable real worktree; accept a structured external startup failure only when terminal evidence and released lock are proven.
- [ ] Confirm the acceptance contract remains `code_change` / `repo` with no migration-only requirement.
- [ ] Commit only task-specific files and report local integration evidence.
