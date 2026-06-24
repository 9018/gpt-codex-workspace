# Multi-Task Delivery Architecture

> Part of the GPTWork delivery system — defines how user requests become completed,
> accepted, integrated tasks.

## Overview

The delivery system transforms a user request (from ChatGPT, Codex CLI, or API) through
a pipeline of discrete stages: encoding → context bundling → queue scheduling →
execution isolation → verification → acceptance → repair → integration → completion.

### Core Principles

1. **Isolation first**: Each task executes in its own Git worktree. No shared mutable state
   between concurrent task executions.
2. **Side-effect-free planning**: The queue planner only reads state and produces plans.
   All mutation (git, files, locks) happens in the worker/materialization stage.
3. **Evidence-based acceptance**: No task is completed without passing acceptance checks
   verified by the acceptance agent.
4. **Automatic repair**: Acceptance failures auto-create repair tasks up to a configurable
   budget before requiring human review.
5. **Serial integration**: Tasks targeting the same repo/branch integrate serially to
   avoid merge conflicts, even though they execute concurrently.

## Pipeline Flow

```
User Request
    │
    ▼
[create_encoded_goal] ────────► Context Bundle (Zvec/retrieval)
    │
    ▼
[Queue Scheduler] ────────────► Dependency resolution, eligibility checks
    │
    ▼
[Worktree Materialization] ───► Git worktree add, branch creation
    │
    ▼
[Codex Execution] ────────────► Task runs isolated in worktree
    │
    ▼
[Verification/Evidence] ──────► Git diff, verification log, result parse
    │
    ▼
[Acceptance Agent] ───────────► Profile-based evidence checks
    │                        ┌──► Repair Loop (auto-fix failures)
    ▼                        │
[Integration Queue] ◄─────────┘
    │
    ▼
[Completion] ─────────────────► Notification, cleanup
```

## Key Components

| Component | File | Responsibility |
|---|---|---|
| Delivery contracts | `backend/src/delivery-contracts.mjs` | State machine, contract constants, validation |
| Goal queue | `backend/src/goal-queue.mjs` | Queue scheduling, eligibility, dependency management |
| Task repo resolution | `backend/src/task-repo-resolution.mjs` | Resolve repo_id → canonical path, worktree plan |
| Worktree manager | `backend/src/task-worktree-manager.mjs` | Git worktree lifecycle (add/remove/prune) |
| Codex worker runner | `backend/src/codex-worker-runner.mjs` | Task execution in worktree |
| Context bundle builder | `backend/src/context-index/context-bundle-builder.mjs` | Build context from Zvec/retrieval |
| Acceptance agent | `backend/src/acceptance-agent.mjs` | Evidence-based acceptance verification |
| Repair loop | `backend/src/repair-loop.mjs` | Auto-repair from acceptance failures |
| Integration queue | `backend/src/integration-queue.mjs` | Serial merge/push for same repo/branch |
| Self-healing policy | `backend/src/self-healing-policy.mjs` | Auto-recovery from common errors |
| E2E delivery | `backend/scripts/e2e-delivery-smoke.mjs` | End-to-end smoke test |

## Dependency Graph

```
GOAL-00 (contracts)
    ├── GOAL-01 (worktree lifecycle)
    │   ├── GOAL-02 (queue scheduling)
    │   ├── GOAL-03 (result contracts)
    │   ├── GOAL-07 (integration)
    │   └── GOAL-08 (self-healing)
    └── GOAL-04 (context management)
        └── GOAL-05 (acceptance agent)
            ├── GOAL-06 (repair loop)
            └── GOAL-07 (integration)
```

See [goal-dependency-graph.json](../gptwork_delivery_goals_2026-06-24/configs/goal-dependency-graph.json)
for the full graph including parallelizable groups.
