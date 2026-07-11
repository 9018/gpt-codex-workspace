# G6 — Apps SDK Workstream 产品体验与决策界面

## Delivered behavior

G6 adds a bounded `workstream_status` Apps SDK card view model that presents Workstream identity and phase, DAG readiness/blocking, task execution, TUI and subagent progress, acceptance and repair state, pending ChatGPT decisions, diagnostics, and next actions in one view. The existing generic/legacy card path remains available through `legacyFieldsFromCard` and text rendering.

## Product directions considered

1. **Operations dashboard** — dense status summary, key values, ordered sections, diagnostics, and explicit actions. Best for quickly understanding health and deciding the next operation.
2. **Graph-first canvas** — DAG dominates the card, with task and acceptance information in secondary panels. Strong for orchestration analysis but weaker when graph data is absent.
3. **Timeline/activity feed** — execution events and subagent updates dominate. Strong for live observation but weaker for deterministic acceptance and repair decisions.

Selected direction: **Operations dashboard**. It directly supports the primary outcome: understand Workstream health and take the next action in one bounded view. DAG data is shown when available and falls back to a task-status list when graph detail is absent.

## Interfaces and files

- `backend/src/workstream/workstream-card-view-model.mjs`
  - Exports `buildWorkstreamStatusCard(tool, data, meta)`.
  - Produces `gptwork-card-v1` with bounded sections, actions, key values, progress, and diagnostics.
- `backend/src/card-view-model.mjs`
  - Registers `workstream_status` as a card-enabled tool and dispatches to the Workstream builder.
- `backend/src/apps-sdk-card/tool-result.mjs`
  - Adds bounded model-facing Workstream fields while preserving card payload separation and legacy compatibility.
- `backend/test/workstream-card-view-model.test.mjs`
  - Covers complete, minimal, DAG fallback, task risk, TUI/subagent, acceptance/repair, ChatGPT request, severity, actions, and compatibility behavior.

No dedicated widget markup change was required: the existing unified card renderer already supports table, list, checklist, key-value, progress, diagnostics, and action sections used by this view model.

## Interaction states

- Healthy or informational Workstream: neutral status and progress.
- Blocked DAG nodes: warning severity plus a deterministic `dag_blocked_nodes` diagnostic.
- Failed or blocked tasks / explicit errors: error severity.
- Missing DAG: list fallback based on task status.
- Pending ChatGPT request: visible count, request table, and informational diagnostic.
- Exhausted repair budget: repair state and warning diagnostic.
- Empty payload: stable informational card without invented sections.

## Accessibility

The card uses textual labels for status and severity rather than color alone. Sections have explicit titles; checklist entries expose status text; actions include descriptive labels; long task/request text is bounded to avoid unusable layouts. Legacy text rendering remains available.

## Compatibility and migration

- Existing card version remains `gptwork-card-v1`.
- Existing tools and generic card builders are unchanged.
- Legacy `keyValues` / `items` derivation remains active.
- Text mode continues to omit card payloads.
- Workstream fields exposed to the model are explicitly allowlisted; raw task, stdout, and stderr payloads are not added.

No persisted-state migration is required.

## QA and verification

Exact command:

```bash
node --test backend/test/workstream-card-view-model.test.mjs backend/test/apps-sdk-card-smoke.test.mjs backend/test/card-view-model.test.mjs
```

Result: **83 tests passed, 0 failed**.

Additional syntax checks:

```bash
node --check backend/src/apps-sdk-card/tool-result.mjs
node --check backend/src/workstream/workstream-card-view-model.mjs
```

Result: passed.

QA comparison against the selected operations-dashboard direction:

- One view exposes identity, graph, task, execution, acceptance/repair, decision, and next-action state.
- Empty and graphless payloads remain readable.
- Explicit errors outrank warnings; blocked graph-only state remains warning.
- Existing Apps SDK smoke and card rendering tests remain green.

## Limitations

The current widget renders the DAG as bounded summary/table/list data rather than an interactive node-link canvas. Live TUI details depend on the structured fields supplied by the calling tool. The card intentionally truncates large collections.

## Next dependency

G7 may consume this card in final integration and release verification after G6 is accepted and merged.

## Completion commit

- d8d1cfa — G6 implementation, tests, and initial owned documentation.
- 093c39d — owned-document completion evidence.
- Compatibility follow-up restores the full bounded worker_status public payload contract.
