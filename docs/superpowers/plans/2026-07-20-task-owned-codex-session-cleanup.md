# Task-Owned Codex Session Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task completion, cancellation, stopping, timeout, and deletion consistently clean every native Codex session attributable to that task, while keeping GPTWork as a thin GPT→Codex control layer.

**Architecture:** Extend the existing Codex session lifecycle manager with task-scoped discovery and cleanup based on existing control records/manifests plus native-session cwd/time metadata. Reuse that single cleanup entry from terminalization, cancellation, and task deletion instead of introducing a new domain model.

**Tech Stack:** Node.js ESM, existing GPTWork state/session stores, node:test.

## Global Constraints

- Keep the native Codex execution model unchanged.
- Do not introduce a second task/session hierarchy.
- Never delete native sessions that cannot be attributed to the target task.
- Preserve structured task results and logs.

---

### Task 1: Add task-scoped native session cleanup
- [ ] Write failing lifecycle-manager tests for multiple native sessions owned by one task.
- [ ] Implement task-scoped attribution and cleanup using control records, manifests, task id, cwd roots, and task start time.
- [ ] Verify unrelated concurrent sessions remain untouched.

### Task 2: Route all task terminal paths through one cleanup entry
- [ ] Add failing tests for cancellation and deletion cleanup.
- [ ] Call the task-scoped cleanup from cancellation and delete_task/delete_tasks before state removal.
- [ ] Keep existing single-session terminal cleanup idempotent.

### Task 3: Regression verification
- [ ] Run focused Codex lifecycle, cancellation, deletion, and TUI terminalizer tests.
- [ ] Run syntax/import checks.
- [ ] Review git diff for unrelated changes.
