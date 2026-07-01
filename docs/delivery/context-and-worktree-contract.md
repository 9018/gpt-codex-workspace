# Context and Worktree Contract

This contract defines how GPTWork gives Codex bounded context, how compact review works, and how worktree/integration state must be interpreted.

## Context Entry Contract

Codex must start each assigned goal from:

```text
.gptwork/goals/<goal_id>/codex.entry.md
```

`codex.entry.md` is the bounded execution entrypoint. It includes the task title, workspace, user request, goal prompt, context lookup policy, result contract, safe restart rule, and required legacy stdout report.

Default lookup order:

1. Read `codex.entry.md` first.
2. Prefer `context.bundle.md` for supporting context when present.
3. Use `context.json` only for targeted metadata lookup.
4. Deep-read `goal.md` only when entry and bundle are insufficient.
5. Deep-read `transcript.md` only for explicit conversation lookup.
6. Do not read payload files unless debugging payload encoding or missing fields.

The goal is smaller, deterministic execution context. Workers should not read full goal context by habit.

## Context Bundle Contract

`context.bundle.md` is an auto-generated, bounded support document. It may include selected current-goal context, recent workspace/repo results, relevant prior goal snippets, constraints, and omissions. It is optimized for task execution, not for archival truth.

Bundle rules:

- Include source attribution and retrieval metadata.
- Prefer relevant summaries and snippets over full transcripts.
- Respect token/chunk budgets.
- State omitted sources explicitly.
- Avoid secrets and raw environment values.

`context.bundle.md` is preferred over `transcript.md` for initial context. If it is missing or insufficient, Codex may do targeted lookup in deeper files.

## Context Retrieval Contract

When retrieval runs, GPTWork writes:

```text
.gptwork/goals/<goal_id>/context.retrieval.json
```

It records:

- store name, such as `zvec-collection-store` or `local-json-store`
- requested and effective retrieval mode
- store capabilities
- embedding provider
- cross-goal and per-goal retrieval counts and previews
- bundle budgets, top-K settings, max scanned goals, and filters
- selection reasons for chunks included in the bundle

Zvec is optional and rebuildable. It is not the source of truth. Durable facts remain in goal/task/result state, conversation records, Git commits, and runtime diagnostics.

## Context Manifest Contract

When a bundle is generated, GPTWork also writes:

```text
.gptwork/goals/<goal_id>/context.manifest.json
```

The manifest is produced by the `context_curator` role. It records the minimal context package, artifact paths, lookup policy, and retrieval diagnostics. The default package is always:

```text
codex.entry.md + context.bundle.md
```

`context.manifest.json` is diagnostic metadata, not primary task context. Codex may read it when it needs to inspect the curator output, selected artifact paths, store mode, retrieval mode, embedding provider, budgets, or selected chunk counts. It must not replace `codex.entry.md` as the first file or make `goal.md`/`transcript.md` default reads.

Runtime knobs:

```bash
GPTWORK_CONTEXT_VECTOR_STORE=auto
GPTWORK_CONTEXT_VECTOR_STORE=zvec
GPTWORK_CONTEXT_VECTOR_STORE=local
GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS=2048
GPTWORK_CONTEXT_BUNDLE_MAX_CHUNKS=8
GPTWORK_CONTEXT_CROSS_GOAL_TOP_K=4
GPTWORK_CONTEXT_PER_GOAL_TOP_K=4
GPTWORK_CONTEXT_MAX_GOALS_SCANNED=20
```

`project_context_status` / `context_status` exposes a safe context-index summary without secret values.

## Compact Review Packet Contract

Review and closure should prefer compact packets over full context reads:

```text
get_task_acceptance_bundle(task_id)
get_task_review_packet(task_id)
```

The acceptance bundle includes:

- task and goal identifiers
- compact contract summary
- result summary
- verification commands and status
- contract verification
- closure decision
- integration summary
- changed files
- blockers, non-blocking follow-ups, quality notes
- missing evidence
- report paths, excluding transcript and full context bundle paths

The review packet adds:

- reason for review
- compact git summary
- key evidence
- blocking findings
- recommended next action

These packets must not include complete transcript, durable memories, complete `context.bundle.md`, payload files, or large diffs. If evidence is absent, the packet reports `missing_evidence` instead of pretending the task is complete.

Review means a human decision is needed. It is not the same as task failure.

## Worktree Contract

Each Codex execution task uses an isolated worktree when the repository supports it.

Lifecycle metadata shape:

```json
{
  "mode": "git_worktree",
  "ok": true,
  "source_root": "/path/to/canonical/repo",
  "base_ref": "main",
  "base_sha": "abc123",
  "branch_name": "gptwork/task-abc123",
  "worktree_path": "/path/to/worktree",
  "dirty_source": false,
  "created_at": "2026-06-24T00:00:00.000Z",
  "cleanup_policy": "remove_on_success_retain_on_failure"
}
```

Rules:

1. Queue dry-run and dependency checks must not create worktrees.
2. Worktree creation happens only during execution materialization.
3. Canonical repo dirty state is recorded and may block integration, but task execution occurs in the isolated worktree.
4. Failed or review-needed tasks retain useful worktree/diff evidence by policy.
5. Stale worktree pruning only removes terminal, TTL-expired worktrees that have no active lock.

Cleanup policies:

| Policy | Behavior |
|---|---|
| `always_remove` | Remove worktree immediately after task completion. |
| `remove_on_success_retain_on_failure` | Remove on success and retain on failure/review. |
| `always_retain` | Never auto-remove worktree. |

## FF-Only Integration Contract

Integration is separate from verification, acceptance, deployment, and closure.

Valid integration distinctions:

- `branch_pushed`: a branch exists remotely; not merged.
- `pr_opened`: a branch was pushed and a PR exists; not merged.
- `merged`: changes entered canonical main.
- `skipped` / `not_required`: integration was explicitly not required.

Required semantics:

- `branch_pushed != merged`
- `pr_opened != merged`
- `merged != deployed`
- `health 200 != running expected commit`

ff-only integration completion may close the integration gap only when:

1. the candidate commit and branch/worktree are known,
2. canonical main can fast-forward without conflict,
3. required verification passes after integration or valid reusable evidence exists,
4. result and contract evidence do not contain blocking findings,
5. deployment was not requested, or deployment evidence is separately present.

If a push or PR exists but the branch is not merged, closure should require review, follow-up integration, or explicit user acceptance of that state.

## Result Contract

Codex tasks should write structured results with at least:

```json
{
  "status": "completed",
  "summary": "one-line summary",
  "changed_files": [],
  "tests": "commands and pass/fail evidence",
  "commit": "sha or none",
  "remote_head": "sha or none",
  "warnings": [],
  "followups": [],
  "verification": {
    "commands": [],
    "passed": true
  }
}
```

`verification.passed` only says commands/checks passed. It does not by itself prove acceptance, integration, deployment, or closure.

## Safe Restart Contract

For self-restart tasks, Codex must:

1. finish edits, verification, commit, and result files,
2. write `result.json` before scheduling restart,
3. call `schedule_service_restart(task_id, expected_commit, expected_remote_head?)`,
4. let the detached scheduler restart and verify runtime state.

Inline restart or process-kill commands can interrupt final result writeback and are not allowed for self-restart tasks.
