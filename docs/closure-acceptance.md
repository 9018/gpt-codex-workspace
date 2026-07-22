# Closure and Acceptance

> Source-backed as of 2026-07-22.

## Purpose

Closure is not “the model finished speaking”. Closure means the backend can prove one of:

- completed with sufficient evidence
- repair is required and budgeted
- integration is required/waiting
- human review is required
- terminal failure/block is justified

## Main Modules

| Module | Role |
|---|---|
| `acceptance-agent.mjs` | evidence-based acceptance checks and findings |
| `task-convergence.mjs` | post-run status convergence |
| `task-finalizer.mjs` | final status decision from aggregated evidence |
| `pipeline-orchestration.mjs` | agent_run gate checks before closure |
| `repair-loop.mjs` | repair goal creation and budget policy |
| `integration-queue.mjs` | serial integration and lock handling |
| `task-final-writeback.mjs` | durable writeback of final state |

## Acceptance Inputs

Typical inputs:

- task/goal metadata
- provider result (`result.json` / normalized task result)
- changed files / commit
- tests / verification
- runtime diagnostics
- existing findings and reviewer decision

Acceptance produces:

- `passed` or not
- findings
- reviewer decision
- repair proposals
- next tasks (optional)

## Finalizer Decision Order

`decideTaskFinalState(evidence)` roughly prioritizes:

1. provider endpoint failure -> blocked
2. capacity/rate-limit failure -> waiting capacity style hold
3. semantic/manual-approval blockers -> waiting_for_review
4. verified no-change completion path -> completed
5. verification + acceptance + contract + integration satisfied -> completed
6. integration required but not terminal -> waiting_for_integration
7. repairable failure with budget -> waiting_for_repair
8. unrecoverable failure/timeout -> failed/timed_out
9. existing holds preserved when no stronger evidence
10. otherwise waiting_for_review for insufficient terminal evidence

## Contract and Pipeline Gates

New tasks often carry:

- acceptance contract artifacts under the goal directory
- `require_pipeline_gates=true`
- agent_runs for planner/builder/verifier/reviewer/finalizer/integrator

`applyPipelineGateBeforeClosure()` can demote an otherwise optimistic status if required roles/gates are unsatisfied.

Legacy tasks may bypass missing gates, but should be treated as compatibility behavior.

## Repair Policy

Repair is allowed only when:

- findings/failure class are repairable
- repair budget remains
- policy does not deny repair
- parent is not already in a non-repairable convergence state

Repair tasks that themselves fail should not infinite-loop the parent; finalizer has explicit escape paths for repair-task holds.

## Integration Policy

If acceptance passes and there are code/config/runtime changes:

- run integration queue against target branch
- classify terminal complete / repairable conflict / wait states
- optionally attempt auto-integration completion

If no relevant changes:

- mark integration `not_required` as terminal evidence

## Human Review

Human/supervisor review is the correct destination for:

- insufficient evidence
- semantic ambiguity
- policy uncertainty
- exhausted repair budget
- provider unavailable when not auto-healable
- manual terminal decisions

Typed review statuses live in `task-status-taxonomy.mjs` / `task-review-status-taxonomy.mjs`.

## Closure Checklist

A task should not be closed as completed unless:

1. result evidence exists and is coherent
2. acceptance is satisfied or explicitly waived by a proven no-change path
3. blocking findings are empty
4. integration is terminal (`completed` or `not_required`)
5. pipeline gates are satisfied for non-legacy tasks
6. finalizer returns `completed` with `safeToAutoAdvance` semantics when queue advance is expected
