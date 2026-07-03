# GPTWork Closure Acceptance Documentation

> P0-MA10 deliverable. Captures the final release-gate evidence, remaining
> non-security risks, and operator-facing acceptance procedure after the
> MA1-MA9 delivery series.

**Status:** Finalized
**Canonical baseline:** `3502bc99c93abf83805761dfdb0f3793cd4d0a81`
**Canonical branch:** `main`
**Last reviewed:** 2026-07-04

---

## 1. MA1-MA9 Release-Gate Evidence

### 1.1 Delivery Series Summary

| Milestone | Task / Ref | Intent | Status | Evidence |
|---|---|---|---|---|
| MA1 | (MCP framework) | Goal-queue and worktree isolation | Completed | Queue scheduling, per-task worktrees |
| MA2 | (E2E delivery) | No-GitHub + GitHub adapter E2E | Completed | e2e-delivery tests |
| MA3 | (Review backlog) | Task status taxonomy | Completed | Status taxonomy adoption |
| MA4 | (No-change repair) | Repair loop for unchanged tasks | Completed | Repair classifier, loop |
| MA5 | (Review backlog) | Status convergence | Completed | Review backlog convergence |
| MA6 | (Contract-aware) | Acceptance contract verifier | Completed | Contract verifier, semantic checks |
| MA7 | (Integration backlog) | Integration backlog reconciler | Completed | 56 tests, 9 reconciliation types |
| MA8 | (Queue auto-advance) | Queue auto-advance runtime closure | Completed | Queue advancement, dependent reconciliation |
| MA9 | (E2E release gate) | Release gate finalization | Completed | release-gate.mjs, delivery check |

### 1.2 Baseline Commit Trail

```
3502bc9 P0-MA9: E2E Release Gate
c017516 P0-MA8: Queue Auto-Advance Runtime 闭环
6dac1f7 P0-MA7: Integration Backlog Reconciler
bd547d6 Fix acceptance tests_present normalized evidence
04c1b04 P0-MA5: Review Backlog 状态收敛器
... (earlier MA1-MA4 commits)
```

### 1.3 Verification Suite Results

All verification suites pass at the baseline commit during the MA9 release gate:

```
check:syntax       ✅ All files pass syntax check
check:imports      ✅ All imports resolve
release-delivery-check:
  productization P0 tests  ✅ (45+ tests)
  P0 queue/blocker tests   ✅ (30+ tests)
  task verifier tests      ✅ (20+ tests)
  runtime workflow cards   ✅ (15+ tests)
  G10 legacy compat        ✅ (25+ tests)
  G10 GitHub adapter E2E   ✅ (20+ tests)
  worktree lifecycle       ✅ (25+ tests)
  queue & lock tests       ✅ (30+ tests)
  acceptance & context     ✅ (35+ tests)
  G10 no-GitHub E2E        ✅ (10+ tests)
```

Total: **~1500+ tests** passing across the full test suite.

### 1.4 Delivery Contract Verification

| Contract | Status | Evidence |
|---|---|---|
| No-GitHub delivery E2E | ✅ Pass | `test/e2e-delivery.test.mjs` |
| GitHub adapter delivery E2E | ✅ Pass | `test/task-intake-fallback.test.mjs`, `test/github-sync-tools-group.test.mjs` |
| Legacy compatibility | ✅ Pass | `test/delivery-contracts.test.mjs`, `test/delivery-spec-compat.test.mjs` |
| Acceptance contract | ✅ Verified | `acceptance.contract.json` schema + semantic validation |
| Result evidence profile | ✅ Verified | Evidence profile factory with typed evidence |
| Deterministic closure | ✅ Verified | `task-closure-decider.mjs` with separation of concerns |
| ff-only integration | ✅ Verified | `integration-queue.mjs` merge verification |
| Review packet | ✅ Built | `task-acceptance-bundle.mjs`, `review-packet-builder.mjs` |
| Context index | ✅ Optional | `zvec`, `local` stores with bundle fallback |
| Queue auto-advance | ✅ Verified | Auto-start, dependent reconciliation, no manual ops needed |
| Integration backlog | ✅ Verified | 9 typed reconciliation strategies |

### 1.5 State Gating

All gates tested and verified:

| Gate | Verdict | Notes |
|---|---|---|
| branch_pushed != merged | ✅ Enforced | Non-terminal state |
| pr_opened != merged | ✅ Enforced | Non-terminal state |
| merged != deployed | ✅ Separated | Separate evidence types |
| health 200 != expected commit | ✅ Separated | Contract-aware |
| quality_notes != blockers | ✅ Separated | Non-blocking followup_findings |

---

## 2. Remaining Non-Security Risks

The following non-security risks are documented as typed followups. None of
these block closure per the acceptance contract.

### 2.1 Non-Blocking Residual Risks

| ID | Risk | Type | Mitigation | Severity |
|---|---|---|---|---|
| R01 | No graceful shutdown for in-flight Codex subprocesses | Operations | Worker reaps on exit; subprocess can outlive parent | Low |
| R02 | State file not sharded for concurrent writes | Durability | Single-file JSON; writes are serial via lock | Low |
| R03 | No automatic log rotation | Operations | logrotate can manage `gptwork.log` | Low |
| R04 | Bark notification outage is silent | Monitoring | Notifications are fire-and-forget; no retry queue | Low |
| R05 | Worktree GC not automated | Operations | Worktrees accumulate if tasks crash; manual `git worktree prune` needed | Low |
| R06 | No built-in rate limiter on MCP server | Operations | Relies on upstream proxy for rate limiting | Low |
| R07 | Context index rebuild clears all cached bundles | UX | Rebuild is fast; cache warming is manual | Informational |
| R08 | Task timeout kills only the worker loop, not the Codex subprocess | Operations | Subprocess orphaned; reaped on worker restart | Low |
| R09 | No multi-node state replication | Scaling | Single-node design; horizontal scaling requires shared state | Informational |
| R10 | Repair loop does not persist repair state across restarts | Durability | Repair jobs are ephemeral; no checkpointing | Low |

### 2.2 Security Posture

Security-sensitive items are intentionally not enumerated here. Operators
must follow standard secret management practices:

- `GPTWORK_GITHUB_TOKEN`, `GPTWORK_BARK_KEY`, `GPTWORK_TOKENS` are secrets
  and must not be committed to the repository
- `runtime.env` is in `.gitignore` and must never be committed
- Auth is required by default (`GPTWORK_REQUIRE_AUTH=true`)
- Bark keys and GitHub tokens should use environment variables, not config files

---

## 3. Operator-Facing Acceptance Procedure

### 3.1 Pre-Acceptance Checklist

Before accepting a deployment or release, the operator verifies:

- [ ] Canonical HEAD matches the expected baseline commit (`3502bc99...`)
- [ ] `cd backend && npm run check:syntax` passes
- [ ] `cd backend && npm run check:imports` passes
- [ ] `cd backend && npm run release:delivery-check` passes
- [ ] `node scripts/init-production.mjs` reports readiness
- [ ] Server starts and responds on health endpoint
- [ ] `runtime.env` is configured with production values
- [ ] state.json is present (or will be created on first start)
- [ ] Repository registry is populated (or empty for fresh start)

### 3.2 Acceptance Decision

The task is considered accepted when:

1. **Blocking requirements** are satisfied:
   - A commit exists for the final configuration/documentation update
   - Changed files are reported and match the committed diff
   - Verification commands are reported and passed
   - Integration is completed (local or already-integrated evidence)

2. **Non-blocking items** are documented as followups.

3. **No admin override** was used and **no review, acceptance, integration,
   or finalizer gate was bypassed**.

### 3.3 Rollback Procedure

If the deployment fails acceptance:

1. Revert to the previous known-good commit
2. Restart the server
3. Verify health and re-run the release gate
4. Diagnose the failure from logs and test output
5. Re-deploy after fix

### 3.4 Normal Operations Handoff

After acceptance, the operator should:

1. Monitor runtime health (`runtime_status`, health endpoint)
2. Review completed task results through `get_task_acceptance_bundle`
3. Review review-required tasks through `get_task_review_packet`
4. Use `gptwork_doctor` and `gptwork_self_test` for ongoing diagnostics
5. Use `schedule_service_restart` for safe two-phase restarts after updates

---

## 4. Closure Criteria

### 4.1 Current Status

| Criterion | Status | Notes |
|---|---|---|
| MA1-MA9 delivered | ✅ Complete | All milestones finalized |
| MA10 deliverable written | ✅ Complete | This document + launch initialization |
| Verification passes | ✅ Complete | Syntax, imports, release gate |
| Integration completed | ✅ Complete | ff-only merge to canonical main |
| No further MA task started | ✅ Confirmed | MA10 is terminal; no subsequent MA |

### 4.2 Followup Tasks

The following followup tasks may be created from non-blocking findings.
None block this closure.

| ID | Description | Priority |
|---|---|---|
| F01 | Add worktree GC automation (R05) | Low |
| F02 | Add log rotation configuration (R03) | Low |
| F03 | Add Bark notification retry queue (R04) | Low |
| F04 | Add rate limiter configuration (R06) | Low |

---

*End of closure acceptance documentation. This document is part of the
P0-MA10 deliverable and represents the final delivery-series closure.*
