# Dual-layer execution, Planner DAG IR, and artifact handoff v3

## Feature flags

All new behavior is opt-in:

- `GPTWORK_EPHEMERAL_BATCH_ENABLED=false`
- `GPTWORK_EPHEMERAL_BATCH_CONCURRENCY=8`
- `GPTWORK_EPHEMERAL_BATCH_MAX_CALLS=32`
- `GPTWORK_PLAN_IR_ENABLED=false`
- `GPTWORK_ARTIFACT_HANDOFF_V3_ENABLED=false`

## Execution model

`classify_execution_intent` deterministically selects ephemeral or durable execution. Unknown tools, write-capable tools, cross-turn recovery, and approval requirements always select durable execution. `run_ephemeral_tool_batch` executes only the conservative read-only allowlist and never creates tasks, goals, worktrees, or repo locks.

## Planner IR

Planner output uses `gptwork.plan_ir.v1`. `validate_plan_ir` and `compile_plan_ir` are pure. `apply_plan_ir` uses one state mutation, optimistic `expected_revision`, stable digest idempotency, and rejects cycles before writes.

## Artifact handoff v3

Agent outputs are registered as `gptwork.artifact_envelope.v1` metadata. Artifact content remains in files; state stores only envelope metadata and digests. `prepare_agent_handoff` compiles a typed input manifest and blocks missing, stale, or producer-mismatched artifacts. Existing pipeline v2 behavior is unchanged.
