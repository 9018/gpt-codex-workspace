# Context and Worktree Contract

> Defines how context bundles are built and how worktree isolation works.

## Context Bundle Contract

The context bundle (`context.bundle.md`) is how long GPTChat transcripts and
relevant history are passed to Codex without overwhelming the prompt window.
Codex starts from `codex.entry.md` and uses `context.bundle.md` as the default
supporting context when present. `context.json`, `goal.md`, and `transcript.md`
remain explicit deep-lookup files rather than default full reads.

Zvec is an optional, rebuildable context index backing retrieval. It is not the
GPTWork source of truth; durable facts remain in goal, conversation, task, and
result state files.

### Runtime Configuration

```bash
GPTWORK_CONTEXT_VECTOR_STORE=auto   # default: use @zvec/zvec when available, otherwise fallback local
GPTWORK_CONTEXT_VECTOR_STORE=zvec   # force Zvec; unavailable Zvec is reported as a clear failure
GPTWORK_CONTEXT_VECTOR_STORE=local  # only use local json fallback
GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS=2048
GPTWORK_CONTEXT_BUNDLE_MAX_CHUNKS=8
GPTWORK_CONTEXT_CROSS_GOAL_TOP_K=4
GPTWORK_CONTEXT_PER_GOAL_TOP_K=4
GPTWORK_CONTEXT_MAX_GOALS_SCANNED=20
```

`project_context_status` / `context_status` exposes a safe `context_index`
diagnostic with configured/effective store, optional dependency availability,
budget settings, top-K settings, scan cap, and warnings. It never exposes secret
values.

### Bundle Contents

1. **Source attribution**: Where each section came from (original goal, task history,
   prior results, repo map).
2. **Summary of requirements**: Condensed from the original user request and goal.
3. **Constraints and rules**: Project conventions, allowed patterns, forbidden changes.
4. **Related prior results**: Relevant previous task outcomes that may inform this task.
5. **Omissions**: Explicit note of what was excluded and why.

### Retrieval Scope

- `current_goal`: The active goal's messages, memories, and context.
- `workspace_recent`: Recent task results in the same workspace.
- `repo_recent`: Recent commits and changes in the target repository.
- `global_project`: Project-wide conventions, env keys, repo maps.

### Retrieval Metadata

Every retrieval records `context.retrieval.json` with:
- `store_name`: Which store was used, such as `zvec-collection-store` or `local-json-store`
- `retrieval_mode` / `requested_retrieval_mode`: Effective and requested retrieval mode
- `store_capabilities`: Vector, hybrid, full-text, and multi-query capabilities reported by the store
- `embedding_provider`: Which embedding provider produced vectors
- `cross_goal_retrieval` and `per_goal_retrieval`: Counts and selected result previews for each phase
- `budget`: Bundle token/chunk limits, top-K settings, max goals scanned, and scoped filters
- `selection`: Why specific chunks entered the bounded bundle

## Worktree Contract

Each task executes in its own Git worktree for complete isolation.

### Worktree Lifecycle Metadata

```json
{
  "mode": "git_worktree",
  "ok": true,
  "source_root": "/path/to/canonical/repo",
  "base_ref": "main",
  "base_sha": "abc123...",
  "branch_name": "gptwork/task-abc123",
  "worktree_path": "/path/to/worktree",
  "dirty_source": false,
  "created_at": "2026-06-24T00:00:00.000Z",
  "cleanup_policy": "remove_on_success_retain_on_failure"
}
```

### Cleanup Policies

| Policy | Behavior |
|---|---|
| `always_remove` | Remove worktree immediately after task completes |
| `remove_on_success_retain_on_failure` | Default. Remove on success, keep on failure |
| `always_retain` | Never auto-remove worktree |

### Key Rules

1. Queue dry-run/dependency-check MUST NOT create worktrees.
2. Worktree creation happens only during `materializing_worktree` stage.
3. Canonical repo dirty state does not block worktree creation (records as warning).
4. Failed tasks preserve worktree and diff evidence by default.
5. Stale worktree pruning only removes terminal + TTL-expired + no active lock trees.
