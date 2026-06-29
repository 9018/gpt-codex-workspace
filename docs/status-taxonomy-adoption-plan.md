# Status Taxonomy Adoption Plan

**Goal:** finish adopting `backend/src/task-status-taxonomy.mjs` for runtime, workflow, and project-context blocker display after the `worker-queue-counts` adoption.

**Current taxonomy baseline:** `TASK_STATUSES`, `ACTIVE_EXECUTION_STATUSES`, `HUMAN_REVIEW_STATUSES`, `REPAIR_STATUSES`, `TERMINAL_STATUSES`, `FAILED_TERMINAL_STATUSES`, and `NON_TERMINAL_WAIT_STATUSES` are covered by `backend/test/task-status-taxonomy.test.mjs`. `backend/src/worker-queue-counts.mjs` already imports `TASK_STATUSES` for counted queue statuses.

## Remaining Duplicates

Targeted runtime/workflow/project-context display modules:

- `backend/src/project-context-service.mjs`: recomputes actionable `waiting_for_review` tasks and `current_blockers` instead of using the queue summary as the single blocker source.
- `backend/src/card-runtime-cards.mjs`: hard-codes runtime/worker queue rows and the `oldest_age_ms` active status list.
- `backend/src/card-view-model.mjs`: hard-codes status severity groups, queue display rows, runtime blockages, task-list review/repair risk, and item risk statuses.
- `backend/src/workflow-state-service.mjs`: hard-codes `waiting_for_review` workflow handling and local blocked/safe-to-advance semantics.
- `backend/src/tool-groups/workflow-tools-group.mjs`: duplicates `waiting_for_review` gates for auto-accept, stale proposal handling, and apply-mode blocker display.

Other backend modules still duplicating task status groups and worth tracking outside this display-focused step:

- `backend/src/state-store.mjs`: duplicate Codex active/terminal status sets and queue filters.
- `backend/src/goal-queue.mjs` and `backend/src/goal-task-task-factory.mjs`: duplicate active task statuses for queue/task creation decisions.
- `backend/src/legacy-reconciliation.mjs`: duplicate legacy review, terminal, active-or-review, and failed status sets.
- `backend/src/task-status.mjs`, `backend/src/retention-service.mjs`, and `backend/src/tool-groups/recovery-tools-group.mjs`: local terminal/active task status lists.

## Smallest Next Production Target

Adopt the taxonomy in `backend/src/project-context-service.mjs` first.

Reason: it already calls `collectWorkerQueueCounts(store)`, and its `current_blockers` output is display-facing. The smallest change is to derive `waiting_for_review` and `actionable_review` directly from `queue.actionable_review` / `queue.waiting_for_review`, while keeping `raw_history.waiting_for_review_total` and resolved legacy detail as historical context. This removes one blocker-semantic duplicate without changing worker behavior, workflow transitions, task creation, or persistence.

## Follow-Up Implementation Tasks

1. **Project context blocker display**
   - Change `backend/src/project-context-service.mjs` so `current_blockers.waiting_for_review` and `current_blockers.actionable_review` use the normalized queue counts from `collectWorkerQueueCounts`.
   - Keep `raw_history` as historical detail only.
   - Add or update a focused assertion in the `open_project_context` tests that a resolved legacy review task does not appear as an actionable blocker.
   - Run:
     - `node --test backend/test/task-status-taxonomy.test.mjs backend/test/worker-queue-counts.test.mjs backend/test/productization-p0.test.mjs`
     - `npm --prefix backend run check:imports`
     - `npm --prefix backend run check:syntax`

2. **Runtime card queue/blockage display**
   - Update `backend/src/card-runtime-cards.mjs` and the runtime branch of `backend/src/card-view-model.mjs` to render queue rows from taxonomy-backed queue keys instead of local arrays.
   - Use queue-provided `actionable_review` for blockage display when present, so resolved legacy review history does not show as a current blocker.
   - Include `waiting_for_integration` consistently anywhere the queue breakdown is displayed.
   - Run:
     - `node --test backend/test/task-status-taxonomy.test.mjs backend/test/worker-queue-counts.test.mjs backend/test/runtime-status.test.mjs backend/test/worker-status.test.mjs backend/test/card-view-model.test.mjs`
     - `npm --prefix backend run check:imports`
     - `npm --prefix backend run check:syntax`

3. **Workflow review/blocker gates**
   - Update `backend/src/workflow-state-service.mjs` and `backend/src/tool-groups/workflow-tools-group.mjs` to use taxonomy helpers for review-status checks and shared helper output for workflow blockers.
   - Preserve the existing behavior that review-state tasks consume acceptance metadata before global runtime safety gates.
   - Add or adjust workflow tests covering `waiting_for_review` auto-accept, repair proposal, and apply-mode blocked output.
   - Run:
     - `node --test backend/test/task-status-taxonomy.test.mjs backend/test/workflow-tools-group.test.mjs`
     - `npm --prefix backend run check:imports`
     - `npm --prefix backend run check:syntax`

## Gaps And Notes

- No production behavior is changed in this plan-only step.
- `backend/test/task-status-taxonomy.test.mjs` already asserts the exported status groups and classifiers, so no missing taxonomy assertion was added.
- Several modules outside runtime/workflow/project-context still duplicate task status groups; they should be handled after the display path is unified to keep blast radius small.
