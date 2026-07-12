# E2E Delivery Workflow and Acceptance

> Documents the end-to-end delivery pipeline from queued goal to terminal task state,
> covering the acceptance gate, finalizer, unified decision model, integration,
> restart boundaries, and change-type terminalization rules.

**Status**: Current
**Last reviewed**: 2026-07-07

## Delivery Pipeline Overview

The delivery system transforms a queued goal into a completed, verified, integrated
result through discrete pipeline stages. Each stage is owned by a dedicated module
and produces evidence consumed by downstream gates.

```
Queued Goal
    │
    ▼
[Queue Scheduler] ─────► dependency resolution, eligibility gates, worktree materialization
    │
    ▼
[Codex Execution] ─────► task runs in isolated worktree, produces result.json + commit
    │
    ▼
[Verification] ────────► syntax, imports, tests, change-type detection
    │
    ▼
[Acceptance Gate] ─────► evidence-based profile checks, contract verification
    │
    ▼
[Integration Queue] ───► serial ff-only merge / push for mutating changes
    │
    ▼
[Finalizer] ───────────► terminal state decision (completed / repair / review)
    │
    ▼
[Unified Decision] ────► normalised status propagated to goal, queue, notifications
```

## Pipeline Stages

### 1. Queue Scheduler

The queue scheduler (`goal-queue.mjs`) turns queued goals into executable tasks.
Auto-advance (`queueAutoAdvanceTick`) runs on every worker tick cycle:

1. Runs the queue reconciler to fix stale blockers
2. Applies nine typed eligibility gates (dependency, acceptance, integration,
   finalizer, repo concurrency, repo lock, dirty worktree, etc.)
3. Advances the first fully-eligible item
4. Materialises a git worktree and assigns the task to Codex

Key components:
- [Queue Auto-Advance](queue-auto-advance.md) — full reference for typed gates and reconciler
- [Task State Machine](delivery/task-state-machine.md) — state transitions
- [Context and Worktree Contract](delivery/context-and-worktree-contract.md) — worktree lifecycle

### 2. Codex Execution

Codex receives the bounded execution context (`codex.entry.md` + `context.bundle.md`)
and runs the assigned goal in the worktree. It produces:

- `result.json` with status, changed_files, commit, verification evidence
- `result.md` with markdown summary
- Git commit of changes in the worktree branch
- Optional `acceptance.contract.json` for contract-override profiles

### 3. Verification

`verifyTaskCompletion` (`task-verifier.mjs`) runs deterministic checks:

- Syntax and import validation
- Changed-files diff against the baseline
- Profile-scoped verification suite (e.g. release gate for code changes)
- Noop/readonly tasks skip heavy checks

Verification output feeds into the acceptance gate as `verification.findings`.
Only findings with severity `blocker` or `major` block the pipeline.

### 4. Acceptance Gate

The acceptance gate engine (`acceptance-gate-engine.mjs`) orchestrates:

1. **Load result** — read `result.json` from the task result
2. **Load contract** — resolve the acceptance contract from goal, task, or
   adjacent `acceptance.contract.json`
3. **Verify** — run `verifyTaskCompletion`
4. **Verify contract** — `verifyAcceptanceContract` checks all blocking requirements
   against result evidence
5. **Decide closure** — `decideTaskClosure` produces a closure status
6. **Produce verdict** — `acceptance.json` artifact with status, passed, closure_decision

Gate produces one of: `passed`, `failed`, `needs_action`.

Reference: [Closure and Acceptance Model](closure-acceptance.md)

### 5. Integration Queue

The integration queue (`integration-queue.mjs`) serialises ff-only merges for
mutating changes. Integration is required when:

- `changed_files` has items AND a commit exists
- `operation_kind` is NOT in `NO_MUTATION_PROFILES` (readonly, diagnostic, noop)

Integration is satisfied when:
- `integration.satisfied === true`, or
- `integration.status` is `merged`, `ff_only_merged`, `skipped`, `not_required`
- The commit is already reachable on the canonical branch (`already_integrated`)

When integration is pending or unconfirmed, the finalizer produces
`waiting_for_integration`. The queue reconciler blocks downstream dependants with
`INTEGRATION_NOT_SATISFIED`.

### 6. Finalizer

The finalizer (`task-finalizer.mjs`, `decideTaskFinalState`) determines the task's
terminal or non-terminal status. Decision order:

1. **Capacity failure** → `waiting_for_capacity`
2. **Manual review blockers** → `waiting_for_review`
3. **No-change repair completion** → immediate terminal
4. **Terminal evidence satisfied** → `completed` with `safe_to_auto_advance`
5. **Integration non-terminal** → `waiting_for_integration`
6. **Repairable failures** → `waiting_for_repair`
7. **Budget exhausted** → `waiting_for_review`
8. **Terminal unrecoverable** → `failed` / `timed_out`

### 7. Unified Decision

The unified decision normalizer (`codex-unified-decision.mjs`) produces a single
`UnifiedAcceptanceDecision` from the finalizer, closure decider, gate, verification,
and contract verification. Canonical fields include:

- `status` — completed, failed, waiting_for_review, waiting_for_repair, etc.
- `safe_to_auto_advance` — queue may advance dependants
- `requires_review`, `requires_repair`, `requires_integration`, `requires_restart`
- `goal_effect` — whether to close the linked goal
- `queue_effect` — whether to unblock dependants or hold the queue

Downstream consumers MUST prefer `unified_decision` over re-deriving status
from individual decision objects when the field is present.

## Terminal States

### Completed
Task passed all gates and reached terminal state. Sub-types:

- `auto_completed_clean` — all gates passed, no followups
- `auto_completed_with_followups` — all gates passed, non-blocking followups noted

### Waiting for Repair
Repairable failures (verification, integration, contract) with remaining budget.
Creates a repair task with `parent_task_id` and `root_task_id`. Bound by
`GPTWORK_MAX_REPAIR_ATTEMPTS` (default: 2).

### Waiting for Review
Non-repairable failures, semantic ambiguity, budget exhausted, or safety concerns.
Requires human intervention.

### Failed / Timed Out
Irrecoverable terminal states: Codex error, fatal integration conflict, timeout.

## Change-Type Terminalization

The system differentiates three change categories, each with distinct terminalization
rules:

| Change Type | Integration Required | Verification | Terminalization Path |
|-------------|---------------------|-------------|---------------------|
| **Docs-only** | No | Syntax + imports | Skips heavy test suites. Contract profile `docs_only` relaxes `tests_present`. Completes as `auto_completed_clean` without integration requirement. |
| **Code/config** | Yes | Full release gate | Requires ff-only merge or `already_integrated` evidence. Blocks downstream with `INTEGRATION_NOT_SATISFIED` if unintegrated. |
| **Runtime** | Yes | Full release gate | Same as code/config, plus `requires_restart` flag. Blocks auto-completion until restart is confirmed or explicitly not required. |

### Generic Terminalization Rule

A task auto-completes when ALL of the following hold:

1. **Accepted** — acceptance gate passed (verification passed, blocking requirements satisfied, contract verified)
2. **Verification passed** — syntax, imports, tests clean
3. **Commit reachable / already integrated** — commit exists on canonical branch or was ff-merged
4. **Clean repo** — canonical repository not dirty at merge time
5. **No restart required** — restart not needed or completed
6. **Integration satisfied / terminal** — integrated, already-integrated, or explicitly not-required

Blockers with severity `blocker` or `major` always block auto-completion.
Non-blocking followups and quality notes do not block closure.

## Restart and Deployment Boundaries

### Restart
- Runtime changes set `requires_restart: true` in the unified decision
- Auto-completion is blocked until restart is confirmed or marked not required
- Safe restarts use `schedule_service_restart` — writes result.json first, then
  schedules detached restart (never inline kill-and-restart)
- Report restart evidence via `integration.requires_restart` and `restart_completed`
  in the task result

### Deployment
- Deployment evidence is separate from integration evidence
- `requires_deployment_check` is a contract-level flag, not inferred from changed files
- Health check and deployment readiness are verified separately by the release gate
- Deployment failures require review, not auto-repair

## Generic vs. Task-Specific Behavior

The delivery system uses **generic** terminalization logic only. There are no
hardcoded task-id special cases. All tasks follow the same pipeline regardless
of topic, milestone, or task_id. The rule applies equally to:

- Code-change tasks (integration required)
- Docs-only tasks (no integration, relaxed verification)
- Noop/sync/diagnostic tasks (no verification, no integration)

## Related Documentation

| Document | Content |
|----------|---------|
| [Closure and Acceptance Model](closure-acceptance.md) | Full architecture for acceptance, finalizer, unified decision |
| [Queue Auto-Advance](queue-auto-advance.md) | Auto-advance tick, typed gates, reconciler |
| [Task State Machine](delivery/task-state-machine.md) | State transitions and terminal states |
| [Acceptance and Repair Contract](delivery/acceptance-and-repair-contract.md) | Profiles, evidence, repair loop |
| [Release Gate](delivery/release-gate.md) | Pre-release checklist and gate script |
| [User Delivery Flow](delivery/user-delivery-flow.md) | End-to-end user journey |
| [Goal Queue](goal-queue.md) | Queue scheduling, eligibility, typed blocked reasons |

*End of E2E delivery workflow document.*

---

## Context Retrieval Hardening — E2E Acceptance (Phase 4)

> This section documents the end-to-end acceptance verification for context pollution
> hardening across Phase 1-4, including the test matrix, product type verification,
> regression tests, and fault injection verification.

### Verification Command

```bash
cd backend && node --test test/context-retrieval-hardening.test.mjs
```

### Acceptance Criteria Results

| Criteria | Status | Evidence |
|----------|--------|----------|
| 测试矩阵覆盖核心组合 (9+) | ✅ PASS | T1-T9: semantic=true/false, fallback, 同 Goal, 依赖 Goal, 跨 Goal, readonly, implementation, 冲突 scope, 超长历史 |
| 故障注入安全降级 | ✅ PASS | T16-T19: 缺失/损坏 contract 返回 warning; embedding 超时降级; 空索引返回 ok=false+warning |
| 四类产物可观测字段验证 | ✅ PASS | T10: manifest 13+ 必选字段; T11: retrieval 9+ 字段; T12: bundle 6 节序; T13: entry 4 个诊断字段 |
| 全套相关测试通过 | ✅ PASS | 42/43 通过，1 个预期失败 (Phase 1 PERMANENT RED store 层污染证据) |
| 文档更新并提交 | ✅ DONE | docs/context-retrieval-hardening.md + docs/e2e-acceptance.md |

### Expected Permanent Failures

| Test ID | Description | Reason |
|---------|-------------|--------|
| Phase 1 Test 1 | Store-level cross-goal contamination evidence | By design — permanent RED evidence proving the meltdown is necessary |

### Goal/Task Reference

| Field | Value |
|-------|-------|
| Goal ID | `goal_85a470fd-bc96-458d-afd5-8fae7e30673c` |
| Task ID | `task_b648fc0a-3719-4419-9dcb-3d52b59527c0` |
| Phase | 4/5 |
| Date | 2026-07-13 |

### Remaining Risk

1. **Phase 5 pending**: Adaptive retrieval budget for large workspaces
2. **Real semantic provider test gap**: Current tests mock or use fallback provider only
3. **Timeout simulation**: Real embedding timeout not possible without external dependency mocking
4. **Production integration**: End-to-end test with actual workspace files not yet covered

### Change Summary (Phase 1-4)

- **Phase 1**: Reproduce contamination, establish baseline with permanent RED evidence test
- **Phase 2**: Non-semantic meltdown (cross-goal disabled when `semantic=false`), intent filtering, manifest warnings
- **Phase 3**: Current Goal Anchor as first bundle section, Optional Historical Context with override warning, entry from contract derivation, contract custom field normalization
- **Phase 4**: 9+ matrix, 4-product verification, regression tests, fault injection (missing/corrupted contract, embedding timeout, empty index)

---

## Context Retrieval Hardening — Phase 5 E2E Acceptance

> Final phase: real TUI empirical evidence, review, and closure.

### Verification Commands

```bash
cd backend && node --test test/phase5-e2e-acceptance.test.mjs
cd backend && node --test test/context-retrieval-hardening.test.mjs test/phase5-e2e-acceptance.test.mjs
```

### Acceptance Criteria Results

| Criteria | Status | Evidence |
|----------|--------|----------|
| Readonly diagnostic Goal with mutation history | ✅ PASS | R1-T1: Goal Anchor 首段, 无 mutation 命令; transcript.md 含完整的修改/提交/部署指令 |
| 五类产物验证 | ✅ PASS | R1-T1-T5: bundle, manifest, retrieval, contract, entry 全部验证通过 |
| 跨 Goal 非语义召回熔断 | ✅ PASS | R1-T2/T3: cross_goal_retrieval.enabled=false, warnings 含 non_semantic_embedding |
| 冲突候选排除原因 | ✅ PASS | R1-T3: candidates 含 source_goal_id/reason/included 字段 |
| Entry readonly/none | ✅ PASS | R1-T5: Execution Diagnostics 显示 readonly, read-only 约束 |
| Codex TUI 真实实证 | ✅ PASS | R2-T1: codex exec readonly prompt — HEAD 不变, repo clean, diff empty |
| Implementation 不被降级 | ✅ PASS | R3-T1-T4: isReadonlyOrDiagnosticGoal=false, bundle 不含 readonly 标签 |
| 全套相关测试通过 | ✅ PASS | 54 tests, 53 pass, 1 expected fail (Phase 1 PERMANENT RED) |

### Goal/Task Reference

| Field | Value |
|-------|-------|
| Goal ID | `goal_11732e6c-ff98-4399-bd80-c695fbc0fedd` |
| Task ID | `task_d72a9010-7dd8-4802-9885-9e94df3a781b` |
| Phase | 5/5 (Final) |
| Date | 2026-07-13 |
| Commit | `063c1ac` |

### Rollback Plan

To roll back Phase 5:
1. Revert commit `063c1ac`: `git revert 063c1ac`
2. Delete the Phase 5 test file: `rm backend/test/phase5-e2e-acceptance.test.mjs`
3. Restore Phase 4 docs: `git checkout HEAD~1 -- docs/context-retrieval-hardening.md docs/e2e-acceptance.md docs/current-status.md`

### Known Limitations

1. **Real semantic provider test gap**: All tests use fallback-hash-sha256 (non-semantic). Real semantic embedding (OpenAI) not tested.
2. **Timeout simulation**: Embedding timeout during `indexGoalContext` is caught by general try/catch — not a real timeout injection.
3. **Cross-goal retrieval with semantic=true**: Disabled by design for non-semantic fallback; behavior with semantic providers not verified in Phase 5.
4. **Codex TUI test**: Uses `codex exec` (non-interactive) rather than full interactive TUI session. The non-interactive path covers the same execution engine.

### Final Conclusion

上下文污染修复闭环完成。所有 5 阶段验证通过：

- Phase 1: 复现污染 + 永久 RED 证据
- Phase 2: 非语义检索熔断 + 意图过滤
- Phase 3: Goal 锚定 + 契约归一化
- Phase 4: 完整测试矩阵 + 故障注入
- Phase 5: 真实 TUI 实证 + 五类产物验证 + implementation 防降级 + 文档闭环
