# Workstream Identity and Context Links

## Delivered Behavior

GPTWork now has a durable `ws_*` Workstream identity in addition to its existing
Goal, Task, and internal `conv_*` conversation identities. Typed Context Links
associate multiple external or internal identifiers with one Workstream without
replacing or rewriting the GPTWork conversation used for local execution context.

The JSON state store has two independent record families:

- `workstreams`
- `context_links`

New Goal and Task records may carry the optional identity fields
`workstream_id`, `root_goal_id`, `parent_goal_id`, `phase`, `iteration`,
`shard_key`, and `workflow_id`. A Task created from a Goal copies these values.
The compatibility `create_task` path accepts the same optional fields, stores
them on the Task, and carries them into its automatically linked Goal.

## Workstream Schema

```json
{
  "id": "ws_gptwork_tui_productization_20260711",
  "title": "GPTWork TUI Workstream Productization",
  "project_id": "default",
  "workspace_id": "hosted-default",
  "repo_id": "default",
  "root_goal_id": "goal_xxx",
  "workflow_id": "wf_gptwork_tui_productization_20260711",
  "status": "planned",
  "summary": "",
  "execution_policy": {
    "max_parallel_tasks": 3,
    "max_tui_sessions": 3,
    "max_subagents_per_task": 4,
    "max_subagent_depth": 1,
    "max_repair_iterations": 2
  },
  "acceptance_policy": {
    "require_clean_worktree": true,
    "require_commit": true,
    "require_tests": true,
    "require_documentation_update": true
  },
  "created_by": "user_default",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

`id`, `created_at`, and `created_by` are immutable. Policy patches merge with
the current policy so an update to one limit does not discard other custom
limits.

## Context Link Schema

```json
{
  "id": "link_xxx",
  "workstream_id": "ws_gptwork_tui_productization_20260711",
  "kind": "chatgpt_conversation",
  "external_id": "conversation-id",
  "relation": "originates",
  "goal_id": "goal_xxx",
  "task_id": null,
  "metadata": {},
  "first_seen_at": "ISO-8601",
  "last_seen_at": "ISO-8601"
}
```

`kind` is an open typed namespace. Initial callers use values such as
`chatgpt_conversation`, `gptwork_conversation`, and `codex_thread`. Re-linking
the same Workstream, kind, external ID, Goal, and Task updates relation,
metadata, and `last_seen_at` rather than creating a duplicate record.

## Goal And Task Identity

```json
{
  "workstream_id": "ws_xxx",
  "root_goal_id": "goal_root",
  "parent_goal_id": "goal_parent",
  "phase": "implementation",
  "iteration": 2,
  "shard_key": "backend",
  "workflow_id": "wf_xxx",
  "conversation_id": "conv_internal"
}
```

`conversation_id` remains the existing GPTWork internal `conv_*` value. An
external ChatGPT conversation or native Codex thread belongs in a Context Link.

## MCP Tool Examples

Create a Workstream:

```json
{"name":"create_workstream","arguments":{"title":"TUI productization","root_goal_id":"goal_root","workflow_id":"wf_root"}}
```

Get one Workstream:

```json
{"name":"get_workstream","arguments":{"workstream_id":"ws_xxx"}}
```

List active Workstreams:

```json
{"name":"list_workstreams","arguments":{"status":"active","limit":20}}
```

Update metadata or policy:

```json
{"name":"update_workstream","arguments":{"workstream_id":"ws_xxx","patch":{"status":"active","execution_policy":{"max_parallel_tasks":2}}}}
```

Link an external ChatGPT conversation:

```json
{"name":"link_workstream_context","arguments":{"workstream_id":"ws_xxx","kind":"chatgpt_conversation","external_id":"chat_123","relation":"originates","goal_id":"goal_root"}}
```

List links for one Workstream:

```json
{"name":"list_workstream_links","arguments":{"workstream_id":"ws_xxx"}}
```

Resolve a native Codex thread:

```json
{"name":"resolve_workstream_by_context","arguments":{"kind":"codex_thread","external_id":"thread_123"}}
```

## Compatibility And Migration

This increment is additive. It does not run a bulk rewrite and does not replace
any `conversation_id`.

- `backup`: Git base `eaac523c838b703abfdfed572a936b09249787c3` is the restore point. The legacy fixture is also compared byte-for-byte before and after read-only queries.
- `dry_run`: `workstream-legacy-migration.test.mjs` loads state with no Workstream arrays or identity fields, then exercises Goal and Task compatibility views without calling `save()`.
- `apply`: New state initializes `workstreams` and `context_links`; explicit Workstream tools create records. No legacy Goal or Task is rewritten merely because it was read.
- `before_count`: Legacy fixture has 0 Workstreams and 0 Context Links, with both arrays absent.
- `after_count`: After the read-only dry run the arrays remain absent and counts remain 0. The explicit tool apply scenario creates 1 Workstream and 3 Context Links.
- `rollback`: Revert the feature commit. Existing legacy state needs no data rollback because it was never rewritten; state created through the new tools can be removed with the feature state or restored from the pre-feature state backup.

Compatibility views derive missing values on copies:

- Goal: `root_goal_id = goal.id`, `iteration = 0`, other missing identity fields are `null`.
- Task: values inherit from its Goal where available, with `root_goal_id` falling back to `goal_id` and `iteration = 0`.
- Internal `conv_*` values pass through unchanged.

## Verification

Focused and regression commands:

```bash
node --test backend/test/workstream-model.test.mjs backend/test/workstream-tools-group.test.mjs backend/test/workstream-legacy-migration.test.mjs
node --test backend/test/goal-tools.test.mjs backend/test/goal-tools-group.test.mjs
node --test backend/test/state-store.test.mjs backend/test/state-store-queue-smoke.test.mjs
node --test backend/test/public-tool-names.test.mjs
node --test backend/test/basic-task-tools-group.test.mjs backend/test/workspace-task-tools.test.mjs
npm --prefix backend run check:syntax
npm --prefix backend run check:imports
```

The final result artifact records the fresh pass counts and any repository-wide
baseline failures observed outside this Goal's required regression surface.

## Changed Files

- `backend/src/workstream/workstream-model.mjs`
- `backend/src/workstream/workstream-store.mjs`
- `backend/src/workstream/workstream-service.mjs`
- `backend/src/workstream/workstream-context-links.mjs`
- `backend/src/tool-groups/workstream-tools-group.mjs`
- `backend/src/state-store.mjs`
- `backend/src/goal-task-goals.mjs`
- `backend/src/goal-task-task-factory.mjs`
- `backend/src/goal-task-creation.mjs`
- `backend/src/goal-task-ensure.mjs`
- `backend/src/task-lifecycle.mjs`
- `backend/src/goal-task-context.mjs`
- `backend/src/tool-groups/goal-tools-group.mjs`
- `backend/src/tool-groups/basic-task-tools-group.mjs`
- `backend/src/server-tools.mjs`
- `backend/src/apps-sdk-card/tool-result.mjs`
- `backend/test/workstream-model.test.mjs`
- `backend/test/workstream-tools-group.test.mjs`
- `backend/test/workstream-legacy-migration.test.mjs`
- `backend/test/goal-tools-group.test.mjs`
- `backend/test/basic-task-tools-group.test.mjs`
- `backend/test/public-tool-names.test.mjs`
- `backend/test/workspace-task-tools.test.mjs`
- `docs/workstreams/tui-productization/01-workstream-context.md`

## Known Limitations

- Context `kind` and `relation` values are intentionally open strings; later product layers may publish a shared vocabulary.
- This Goal does not backfill Workstream IDs into existing persisted Goals or Tasks.
- Workstream DAGs, execution records, TUI worktree isolation, controller ticks, and product UI are owned by later Goals.
- The repository's existing card payload contract has conflicting expectations for raw `task` and `tasks` fields across legacy MCP consumers; this increment preserves current public responses and does not resolve that separate compatibility issue.

## Next Integration Dependency

G2, G3, and G4 consume `workstream_id`, `context_links`, and the Goal/Task
identity fields to add isolated TUI executions, structured progress, and DAG
orchestration. They must continue preserving GPTWork `conv_*` conversations.

## Completion Commit

This document is completed by the commit with message
`feat: add workstream identity and context links`. The exact commit SHA is
recorded in the Goal `result.json` and `result.md` artifacts.
