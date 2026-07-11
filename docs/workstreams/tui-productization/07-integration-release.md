# G7 — Integration, Release, End-to-End and Hourly Supervisor Contract

**Status:** Completed and release-verified
**Workstream:** `ws_gptwork_tui_productization_20260711`
**Root Goal:** `goal_48d055ee-82b6-415b-8d98-65cb7662aaaf`
**Depends on:** G1, G2, G3, G4, G5, G6

## Summary

G7 integrates all six preceding goals into a bounded end-to-end Workstream productization contract and an hourly supervisor contract. It validates the complete lifecycle — workstream creation, multi-context binding, DAG fan-out, independent worktrees, structured subagents, automatic acceptance, repair/convergence, join/integration, and completion — in one e2e test file. The hourly supervisor covers normal advancement, drift/stall detection, ChatGPT direct edit preference, fallback repair tasks, idempotency, and documentation enforcement.

### Integration Contract

No duplicate competing APIs were created. All six goals' outputs are consumed through their existing APIs:

| Goal | Artifact | Integration |
|---|---|---|
| G1 | Workstream identity, context links | Used in e2e-1, e2e-2 |
| G2 | Task worktrees, isolated execution | Modeled in e2e-4 via DAG metadata |
| G3 | Structured subagent progress | Modeled in e2e-5 via progress store |
| G4 | DAG fan-out/join, capacity | Tested in e2e-3, e2e-8 |
| G5 | Acceptance controller, drift/stall, repair | Tested in e2e-6, e2e-7, e2e-10, HS-2 through HS-14 |
| G6 | Workstream Apps SDK card view | Consumed via card-view-model; verified in existing tests |

### End-to-End Productization Test

`backend/test/e2e-workstream-productization.test.mjs` — 11 tests covering:

1. Creating a Workstream with identity fields and duplicate rejection
2. Binding multiple context links (ChatGPT conversation, Codex thread, GitHub issue) with idempotent re-link
3. Fan-out three tasks via DAG with idempotent re-invocation
4. Modeling independent worktrees per shard with unique metadata
5. Structured subagent progress per shard (analyst, architect, implementer, planner, verifier)
6. Automatic acceptance evaluation via `evaluateAcceptance` + `runAcceptanceController`
7. Repair budget handling (2 attempts then escalation) and convergence for partial acceptance
8. Join node with `all_completed` condition, synchronous node state resolver, and downstream integration node
9. Complete Workstream lifecycle (planned → active → completed)
10. ChatGPT direct correction preference over repair goal creation
11. Idempotent acceptance controller (same input = same verdict)

### Hourly Supervisor Contract

`backend/test/workstream-hourly-supervisor.test.mjs` — 14 tests covering:

1. Normal progress — no drift, no stall with clean state
2. Drift detection: phase mismatch, stale progress, wrong scope; correction via direct edit or repair
3. Stall detection: dead TUI session, stale lock; recovery
4. ChatGPT direct edit preference when corrections are available
5. Fallback repair task when no corrections available
6. Idempotent supervisor passes — same state produces same transition counts
7. Documentation enforcement — docs_only profile requires .md files; non-docs profiles pass without docs
8. Repair budget exhaustion after MAX_REPAIR_ATTEMPTS (2)
9. Review backlog reconciliation tick identifies waiting_for_review and waiting_for_repair
10. Task advancement tick advances assigned/queued tasks
11. Deduplication of repair records prevents duplicate actions
12. Composite runTick handles empty state gracefully
13. Supervisor drift detection via tick integration (phase mismatch)
14. Terminal queue task mismatch drift

## Verification Results

### Focused Tests (25/25 pass)

```bash
node --test backend/test/e2e-workstream-productization.test.mjs backend/test/workstream-hourly-supervisor.test.mjs
```

| Test | Pass/Fail |
|---|---|
| G7-e2e-1: Create Workstream with identity | ✅ PASS |
| G7-e2e-2: Bind multiple context links | ✅ PASS |
| G7-e2e-3: Fan-out three tasks into DAG | ✅ PASS |
| G7-e2e-4: Independent worktrees for each shard | ✅ PASS |
| G7-e2e-5: Structured subagents via progress | ✅ PASS |
| G7-e2e-6: Automatic acceptance evaluation | ✅ PASS |
| G7-e2e-7: Repair budget and convergence handling | ✅ PASS |
| G7-e2e-8: Join node integration | ✅ PASS |
| G7-e2e-9: Complete Workstream lifecycle | ✅ PASS |
| G7-e2e-10: Direct correction flow | ✅ PASS |
| G7-e2e-11: Idempotent acceptance controller | ✅ PASS |
| HS-1: Normal progress | ✅ PASS |
| HS-2: Drift detection and correction | ✅ PASS |
| HS-3: Stall detection and recovery | ✅ PASS |
| HS-4: ChatGPT direct edit preference | ✅ PASS |
| HS-5: Fallback repair task | ✅ PASS |
| HS-6: Idempotent supervisor passes | ✅ PASS |
| HS-7: Documentation enforcement | ✅ PASS |
| HS-8: Repair budget exhaustion | ✅ PASS |
| HS-9: Review backlog reconciliation | ✅ PASS |
| HS-10: Task advancement | ✅ PASS |
| HS-11: Deduplication | ✅ PASS |
| HS-12: Empty state handling | ✅ PASS |
| HS-13: Tick drift integration | ✅ PASS |
| HS-14: Terminal queue mismatch | ✅ PASS |

### Syntax Check

```bash
npm --prefix backend run check:syntax
```

Result: PASS.

### Full Backend Test Suite

```bash
npm --prefix backend test
```

Result: PASS. Full backend suite completed with zero failures.

## Key Design Decisions

1. **No parallel API creation**: G7 uses the exact imports from G1–G6 modules without creating wrappers or facades. No existing API is duplicated or replaced.
2. **Synchronous node state resolver**: The `evaluateJoinCondition` function requires a synchronous `getNodeState` resolver. Tests use a direct in-memory DAG node lookup.
3. **Direct correction preference**: When corrections are available, `scheduleRepairAction` returns `direct_correction` before falling back to `create_repair_goal`.
4. **24-hour stale threshold**: Drift detection uses a default 2-hour stale threshold. Stall detection uses TUI heartbeat and lock age heuristics.

## Limitations

1. **Real worktree isolation**: Worktrees are modeled via DAG metadata in the e2e test. Full real-worktree end-to-end testing requires dispatching actual `codex exec` commands with isolated git worktrees.
2. **Subagent progress store**: Structured subagent progress is modeled as DAG node metadata. Real subagent progress would use `subagent-progress-store.mjs` for atomic progress file writes.
3. **Operational environment**: Release verification covers the configured local runtime. External provider availability, credentials, and remote service health remain environment-dependent.

## Documentation Gate

- This document (`07-integration-release.md`) records G7 delivery.
- `docs/workstreams/tui-productization/README.md` updated with G7 entry.
- `docs/current-status.md` updated with workstream productization completion.
- `README.md` and `README.zh-CN.md` updated with references.

## Completion Commit

Implementation and convergence commit: `2ad52bdf6de1c6c6b138c64db4e40d06a684d15d`

Documentation completion commit: `30656952791e5a5cfa03179677ee973290fb55e2`
