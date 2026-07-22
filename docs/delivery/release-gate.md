# Release Gate

> Source-backed as of 2026-07-22.

## Default Autonomous Provider

`codex_tui_goal` is the default autonomous Codex execution provider.

`codex_exec` is:

- an explicit provider choice, or
- an availability fallback when TUI is typed unavailable

It is **not** the product default autonomous path.

Relevant code:

- `backend/src/codex-execution-provider.mjs`
- `backend/src/execution/provider-selection-policy.mjs`
- `backend/src/task-processing/task-provider-dispatcher.mjs`

## Provider Metadata

Tasks may carry:

```json
{
  "metadata": {
    "codex_execution_provider": "codex_tui_goal"
  }
}
```

Aliases:

- `codex_tui` normalizes to `codex_tui_goal`
- empty/default normalizes to `codex_tui_goal`
- `codex_exec` remains explicit non-TUI execution

## TUI Tool Surface

| Tool | Purpose |
|---|---|
| `codex_tui_start_goal` | Start a TUI goal session |
| `codex_tui_status` | Check session status |
| `codex_tui_read` | Read session output |
| `codex_tui_send` | Send input to session |
| `codex_tui_stop` | Stop a running session |
| `codex_tui_collect` | Collect session evidence |
| `codex_native_sessions_list` | List native sessions |
| `codex_native_session_read` | Read native session |
| `codex_native_session_attach` | Attach native session |
| `codex_native_session_status` | Native session status |
| `codex_native_session_send` | Send to native session |
| `codex_native_session_detach` | Detach native session |

## Completion Collection

Completion collection reconstructs durable evidence from:

- goal `result.json` / `result.md`
- TUI/session artifacts
- git/worktree signals when available

The autonomous path then continues through acceptance, convergence, repair/integration, pipeline gates, and finalizer writeback.

## No-Result Handling

When result evidence is insufficient:

- preserve transcript/session diagnostics
- do **not** treat it as ordinary auto-repair fuel by default
- route to human review / typed review states
- avoid blind reruns of the original task

## Runtime Diagnostics

Primary tools:

- `runtime_status`
- `worker_status`
- `product_status`
- `gptwork_doctor`
- recovery diagnostics tools when recovery plane is enabled

## Required Checks Before Release

From `backend/`:

```bash
npm run check:syntax
npm run check:imports
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

Fast path during development:

```bash
node scripts/release-delivery-check.mjs --fast
```

## Security

No secret keys, tokens, cookies, or credentials may appear in:

- session logs
- result artifacts
- review packets
- goal transcripts intended for broad sharing
