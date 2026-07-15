# Context Retrieval Accuracy Closure

## Goal

Improve the existing Zvec-backed context-index without replacing its storage layer. The closed-loop target is to distinguish retrieval intent, suppress unrelated task lineage, prioritize exact entities, and expose deterministic quality metrics in the normal bundle-generation path.

## Architecture

```text
Goal/task query
  -> deterministic intent and entity analysis
  -> existing Zvec hybrid or local fallback retrieval
  -> expanded candidate pool
  -> time decay before final selection
  -> intent/entity/lineage-aware application rerank
  -> bounded bundle selection
  -> retrieval diagnostics and deterministic evaluation
```

Zvec remains the primary optional vector store. The same policy reranker runs above both Zvec and local JSON, so fallback behavior preserves entity and lineage controls.

## Retrieval policy

Supported intent classes:

- `runtime_diagnosis`
- `acceptance`
- `implementation`
- `history`
- `documentation`
- `mixed`

Extracted exact entities:

- task IDs
- goal IDs
- workstream IDs
- commit SHAs
- repository file paths

Ranking combines the store score with exact-entity boosts, intent/source preference, current-task affinity, root-goal affinity, workstream affinity, cross-lineage penalties, deep Followup/Repair penalties, and stale-runtime penalties.

## Lineage controls

Chunk metadata and Zvec fields include:

- `task_id`
- `goal_id`
- `workstream_id`
- `root_goal_id`
- `parent_goal_id`
- `phase`
- `iteration`
- `shard_key`
- `lineage_depth`

Both Zvec filters and local JSON filters enforce workstream/root-goal constraints when supplied. Explicit historical entity queries may cross lineage; unrelated result and conversation chunks are penalized.

## Embedding consistency

Indexing and querying use the same `config.contextEmbeddingConfig`. The fallback hash provider remains the default. Cross-goal retrieval stays disabled when the provider declares `semantic=false`.

## Diagnostics

`context.retrieval.json` now includes:

- retrieval policy and extracted entities
- candidate and selected counts
- score breakdowns and selection reasons
- time-decay diagnostics
- deterministic evaluation metrics

Metrics:

- Recall@K over unique expected entities
- MRR
- source routing accuracy
- exact entity hit rate
- wrong-task context rate
- cross-lineage pollution rate
- stale runtime context rate

## Acceptance checks

1. Exact task, goal, workstream, SHA, and path matches outrank stronger generic vector neighbors.
2. Runtime diagnosis receives current task/root/workstream context.
3. Deep unrelated Followup/Repair chains are penalized.
4. Explicit history queries retain cross-lineage access.
5. Zvec and local fallback apply the same scope and rerank policy.
6. Time decay runs before final top-K selection.
7. Recall metrics cannot exceed 1 when multiple chunks reference one expected entity.
8. Existing context-index and retrieval-hardening tests remain green.
9. Full backend tests, syntax checks, import checks, and repository cleanliness pass.

## Rollback

The change is isolated above the storage adapter. Rollback consists of reverting the policy/evaluator integration commit; existing Zvec indexes remain rebuildable and no new external service is introduced.
