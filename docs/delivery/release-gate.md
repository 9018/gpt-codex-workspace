# Release Gate

> Pre-release verification checklist for the delivery system.

## Gate Requirements

1. All unit tests pass (1448+ tests)
2. Syntax check passes for all source files
3. Import check passes for all modules
4. E2E delivery smoke test passes
5. No blocker or major acceptance findings

## Gate Script

```bash
npm run release:delivery-check
```

## Release Matrix

| Test Area | File | Status |
|---|---|---|
| Delivery contracts | `test/delivery-contracts.test.mjs` | ✅ |
| Worktree lifecycle | `test/task-worktree-manager.test.mjs` | ✅ |
| Queue scheduling | `test/goal-queue.test.mjs` | ✅ |
| Context retrieval | `test/context-index.test.mjs` | ✅ |
| Acceptance policy | `test/acceptance-policy.test.mjs` | ✅ |
| Repo locks | `test/repo-lock.test.mjs` | ✅ |
| E2E delivery | `test/e2e-delivery.test.mjs` | ✅ |

## Codex TUI Provider Smoke Checklist

The default execution provider remains `codex_exec`. Tasks with no explicit provider metadata, or with unrecognized provider metadata, must continue through the existing `codex_exec` path.

`codex_tui_goal` is an explicit optional provider only. A task opts in by setting metadata such as `codex_execution_provider: codex_tui_goal`; the worker must not infer or route to this provider from task text, mode, workspace, or operator preference.

Before release, verify this high-level operator flow without copying sensitive session contents into docs, diagnostics, or test fixtures:

1. Start an explicitly opted-in task with `codex_tui_start_goal`.
2. Check session state with `codex_tui_status`.
3. Read only bounded operator-facing output with `codex_tui_read` when needed; do not publish raw transcript contents, tokens, cookies, cache files, memories, shell snapshots, or secrets.
4. Drive the session with `codex_tui_send`.
5. Stop abandoned or completed sessions with `codex_tui_stop`.
6. Run `codex_tui_collect` for completion collection from durable result evidence, primarily `result.md` and `result.json`, instead of relying on screen text.

Release checks must cover the supporting provider surfaces:

- Provider routing metadata keeps `codex_exec` as the default and requires explicit `codex_execution_provider: codex_tui_goal` opt-in for TUI sessions.
- Manual TUI MCP tools are registered: `codex_tui_start_goal`, `codex_tui_status`, `codex_tui_read`, `codex_tui_send`, `codex_tui_stop`, and `codex_tui_collect`.
- Completion collection reports ready-for-review only when durable result evidence is present and the worktree/result contract is coherent.
- `runtime_status` includes `codex_tui_goal` diagnostics only when TUI config, explicit tasks, or retained sessions make the optional provider relevant.
- Recovery diagnostics through `recovery_plane_status` or `recovery_diagnose` summarize disabled, stale, missing-metadata, and no-result sessions without leaking transcript contents.
- Fallback/no-result handling remains explicit: missing `result.md`, missing `result.json`, dirty worktree, or missing commit evidence should produce findings for operator action, not implicit success.

## Failure Handling

If any gate check fails:
1. Identify the failing module from the output
2. Check the module's test file for the specific assertion
3. Fix the issue and re-run the gate
4. Do not release until the gate passes
