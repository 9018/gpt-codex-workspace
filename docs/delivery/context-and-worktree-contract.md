# Context and Worktree Contract

> Defines how context bundles are built and how worktree isolation works.

## Context Bundle Contract

The context bundle (`context.bundle.md`) is how long GPTChat transcripts and
relevant history are passed to Codex without overwhelming the prompt window.

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
- `store_name`: Which store was used (zvec, local, fallback)
- `embedding_provider`: Which embedding provider (openai, local, fallback-hash-sha256)
- `semantic`: Whether semantic retrieval was used
- `retrieval_scope`: Which scopes were queried
- `query`: The retrieval query
- `results`: Number and quality of results
- `warnings`: Any degradation warnings

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
