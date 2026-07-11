# GPTWork TUI Workstream Productization

## Identity

- Transitional Workstream ID: `ws_gptwork_tui_productization_20260711`
- Workflow ID: `wf_gptwork_tui_productization_20260711`
- Root Goal: `goal_48d055ee-82b6-415b-8d98-65cb7662aaaf`
- Design: `docs/superpowers/specs/2026-07-11-gptwork-tui-workstream-productization-design.md`
- Plan: `docs/superpowers/plans/2026-07-11-gptwork-tui-workstream-productization.md`
- Planning commit: `c1e1561`

## Goal Registry

| Key | Goal ID | Scope | Dependency | Owned documentation | Initial status |
|---|---|---|---|---|---|
| G1 | `goal_c388f884-47fa-45a6-b2ad-85c58626b620` | Workstream identity and Context Links | none | `01-workstream-context.md` | completed |
| G2 | `goal_7e9c6bfb-cf16-4a2c-a0aa-21fff9c9a82d` | Codex TUI task worktrees and executions | G1 | `02-tui-worktree-execution.md` | completed |
| G3 | `goal_553b0517-787a-4bb8-82ac-ef448448d3f0` | structured TUI/subagent progress | G1 | `03-execution-subagents.md` | completed |
| G4 | `goal_1f2a92b5-fde7-4df5-8fd2-21882921ff79` | DAG fan-out/join and capacity | G1 | `04-dag-orchestration.md` | completed |
| G5 | `goal_6e0bd74c-a55d-4e57-b14f-29e9e2e7e1ca` | acceptance, repair, tick, drift/stall recovery | G2 + G3 + G4 | `05-acceptance-controller.md` | completed |
| G6 | `goal_ab65f992-b5a9-4599-a05f-136e7f3cccf3` | Apps SDK Workstream product experience | G1 + G3 + G5 | `06-product-experience.md` | completed |
| G7 | `goal_e1e9d26f-53e1-44fb-9d9e-43a6802aa510` | integration, release, end-to-end and supervisor contract | G1–G6 | `07-integration-release.md` | integration pending |

## Dependency Graph

```text
G1
├── G2
├── G3
└── G4

G2 + G3 + G4
└── G5

G1 + G3 + G5
└── G6

G1 + G2 + G3 + G4 + G5 + G6
└── G7
```

## Execution Policy

- ChatGPT performs small deterministic corrections directly through GPTWork workspace/recovery tools when possible.
- Large implementation, long-running verification, or a blocked direct mutation is delegated as a Codex Goal/Task.
- A repair Task is unique by root Task, failure class, and attempt.
- Maximum repair attempts: 2.
- Maximum automatic transitions per controller pass: 5.
- Maximum intended parallel writing Tasks after worktree isolation is available: 3.

## Documentation Gate

Each Goal owns one document in this directory. This consolidated document references the full record in each goal.

| Key | Scope | Owned Document | Status |
|-----|-------|---------------|--------|
| G1 | Workstream identity and Context Links | `01-workstream-context.md` | ✅ Implemented |
| G2 | Codex TUI task worktrees and executions | `02-tui-worktree-execution.md` | ✅ Implemented |
| G3 | Structured TUI/subagent progress | `03-execution-subagents.md` | ✅ Implemented |
| G4 | DAG fan-out/join and capacity | `04-dag-orchestration.md` | ✅ Implemented |
| G5 | Acceptance, repair, tick, drift/stall recovery | `05-acceptance-controller.md` | ✅ Implemented |
| G6 | Apps SDK Workstream product experience | `06-product-experience.md` | ✅ Implemented |
| G7 | Integration, release, e2e and supervisor contract | `07-integration-release.md` | ✅ Implemented |

## Completed Deliverables

G7 integrates all six preceding goals into a single bounded increment. Key outputs:

- **`backend/test/e2e-workstream-productization.test.mjs`**: 11 e2e tests covering the complete Workstream lifecycle (identity → context links → fan-out → worktrees → subagents → acceptance → repair → join → completion).
- **`backend/test/workstream-hourly-supervisor.test.mjs`**: 14 supervisor contract tests covering normal advancement, drift/stall, ChatGPT direct edit, fallback repair, idempotency, and documentation enforcement.
- **All 25 tests passing** with clean syntax check (562 files).

### Quick Verification

```bash
# Focused G7 tests
node --test backend/test/e2e-workstream-productization.test.mjs backend/test/workstream-hourly-supervisor.test.mjs

# Syntax check
npm --prefix backend run check:syntax

# Full test suite
npm --prefix backend test
```

## Supervisor Contract (from Design)

The hourly supervisor checks the root and seven child Goals, worker/queue/locks, Tasks, TUI sessions, structured progress, review packets, acceptance bundles, Git state, and documentation. It corrects drift, recovers stalls, advances eligible work, and creates bounded repair Tasks only when direct ChatGPT correction is unavailable or unsuitable. Repeated checks over unchanged state must be idempotent.

The supervisor contract is now verified by `workstream-hourly-supervisor.test.mjs` which validates:
1. Normal progress — no drift, no stall
2. Drift detection (phase mismatch, stale progress, wrong scope)
3. Stall detection (dead TUI, stale lock)
4. ChatGPT direct edit preference
5. Fallback repair task when corrections unavailable
6. Idempotent repeated supervisor passes
7. Documentation enforcement through acceptance gate

## Operational Note

The root Goal (`goal_48d055ee-82b6-415b-8d98-65cb7662aaaf`) can be marked complete after G7 is integrated. No further workstream goals are planned for this productization cycle.
