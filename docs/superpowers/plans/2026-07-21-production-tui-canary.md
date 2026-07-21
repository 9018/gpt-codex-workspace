# Production Codex TUI Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the product E2E run a real native Codex TUI task that modifies a controlled file, creates a real commit, passes the real merge gate, merges into local main, and proves terminal Goal/Task closure.

**Architecture:** Extend the existing real-TUI first-loop script to create an isolated Git repository and goal worktree through `ensureGoalWorkspace`, execute `startCodexTuiGoalSession` in that worktree, enforce a strict changed-path allowlist, commit the Codex change, write acceptance evidence, and invoke `applyMergeGate`. The script reports success only when the candidate commit is reachable from main and all execution/session/evidence/merge/closure assertions pass.

**Tech Stack:** Node.js, node-pty, native Codex CLI, Git worktrees, GPTWork goal workspace and merge-gate services.

## Global Constraints

- Native Codex TUI is mandatory; no `codex_exec` fallback.
- Only `production-canary.txt` may be changed by Codex.
- The merge target is local `main`; no GitHub push.
- Failure preserves no false completed state and returns a non-zero exit code.

---

### Task 1: Upgrade the real TUI script

**Files:**
- Modify: `backend/scripts/e2e-tui-first-loop.mjs`

- [ ] Create the goal worktree with `ensureGoalWorkspace`.
- [ ] Start the native Codex TUI in the worktree and wait for the controlled marker.
- [ ] Reject any Codex change outside the marker allowlist.
- [ ] Create a real candidate commit.
- [ ] Generate evidence and acceptance artifacts for the exact candidate head.
- [ ] Run `applyMergeGate` against local main.
- [ ] Verify commit ancestry, merged file content, session metadata, and terminal closure assertions.

### Task 2: Promote it to the product E2E entrypoint

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/test/e2e-product-acceptance.test.mjs`

- [ ] Add an explicit production Canary script.
- [ ] Add a contract test proving the product acceptance command includes the real production Canary.
- [ ] Run static checks, isolated acceptance tests, and the real Canary.
