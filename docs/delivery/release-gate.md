# Codex TUI Provider Release Gate

## Default Autonomous Provider

`codex_exec` is the default execution provider. `codex_tui_goal` is an explicit optional provider.

## Provider Metadata

Tasks specify `codex_execution_provider: codex_tui_goal` to opt in.

## TUI Tool Surface

| Tool | Purpose |
|------|---------|
| `codex_tui_start_goal` | Start a TUI goal session |
| `codex_tui_status` | Check session status |
| `codex_tui_read` | Read session output |
| `codex_tui_send` | Send input to session |
| `codex_tui_stop` | Stop a running session |
| `codex_tui_collect` | Collect session evidence |

## Completion Collection

Completion collection produces a structured result from session artifacts. The pipeline reads result.md and result.json from the goal directory.

## Runtime Diagnostics

Runtime diagnostics are available via `runtime_status` and `recovery_diagnose` tools.

## No-Result Handling

When no result is available (no-result), the system routes to human review. Transcript contents are preserved for diagnostics. Token usage is tracked per session.

## Security

No secret keys, tokens, or credentials may appear in session logs or result artifacts.
