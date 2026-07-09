# Release Gate

> Pre-release verification checklist for the delivery system.

## Gate Requirements

The single baseline release gate is `npm run release:check` from the backend
directory. It is intentionally explicit so a clean clone fails fast if a
referenced script or test file is missing.

1. Syntax check passes for all source files
2. Import check passes for key runtime modules
3. Package release scripts reference files that exist
4. Core release gate passes
5. MA9 and P5 release-gate regressions pass
6. P5 release gate script reports GO

## Gate Scripts

Baseline package gate:

```bash
cd backend
npm run release:check
```

Release candidates should pass all three product gates from a clean worktree:

```bash
cd backend
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

`release:check` runs:

1. `npm run check:syntax`
2. `npm run check:imports`
3. `npm run test:release-scripts`
4. `GPTWORK_TOOL_MODE=full npm run release:gate`
5. `npm run test:p0-ma9`
6. `npm run test:p0-p5`
7. `GPTWORK_TOOL_MODE=full npm run release:p5:gate`

`npm run test:e2e-acceptance` remains available as a broader product
acceptance suite, but it is not part of the baseline gate while its assertions
target pre-v5 raw `structuredContent` payloads instead of the current bounded
model payload plus card metadata contract.

## Release Matrix

| Test Area | File | Status |
|---|---|---|
| G10 legacy compatibility | `test/delivery-contracts.test.mjs`, `test/delivery-spec-compat.test.mjs` | ✅ |
| Worktree lifecycle | `test/task-worktree-manager.test.mjs` | ✅ |
| Queue scheduling | `test/goal-queue.test.mjs` | ✅ |
| Context retrieval | `test/context-index.test.mjs` | ✅ |
| Acceptance policy | `test/acceptance-policy.test.mjs` | ✅ |
| Repo locks | `test/repo-lock.test.mjs` | ✅ |
| G10 no-GitHub delivery E2E | `test/e2e-delivery.test.mjs` | ✅ |
| G10 GitHub adapter delivery E2E | `test/task-intake-fallback.test.mjs`, `test/github-sync-tools-group.test.mjs` | ✅ |

## G10 Release Contract

The release gate must prove three release modes before publishing:

| Contract | Evidence |
|---|---|
| No-GitHub delivery | `G10 no-GitHub delivery E2E` covers create goal, queue start, Codex execution injection, automatic acceptance, repair creation, integration completion, and queue advancement without GitHub credentials. |
| Optional GitHub adapter | `G10 GitHub adapter delivery E2E` covers GitHub issue import, question/task-intake conversion, dry-run no-op behavior, apply behavior, idempotency, and skipped reasons without making live GitHub API calls. |
| Legacy compatibility | `G10 legacy compatibility tests` cover old task status aliases and result-field normalization so existing task history remains readable without state rewrites. |

Fast mode remains a developer smoke gate. Release candidates should use the
baseline release check above. For delivery-specific diagnostics, run the full
delivery check:

```bash
cd backend
node scripts/release-delivery-check.mjs
```

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

## CI/CD Release Gate (GitHub Actions)

A release gate workflow runs automatically on push/PR to `main` via `.github/workflows/release-gate.yml`. It executes in CI:

1. `npm run check:syntax`
2. `npm run check:imports`
3. `npm run release:gate`
4. `npm run release:delivery-check -- --profile full`

The CI gate uses `--profile full` explicitly to match the default behavior of the backend script. Both the root-level wrapper and the backend script default to `full`. Local release candidates should still use `npm run release:check`, which includes the P5 gate and package-script regression in addition to the CI gate components.
