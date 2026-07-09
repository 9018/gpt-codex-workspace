# Codex TUI Mode: Manual Operator Fallback

## Overview

`codex_tui_goal` is a **manual operator fallback** execution provider, not an
automatic execution path.  When enabled, it runs `codex` inside a terminal (PTY)
session and waits for the operator to produce durable evidence.  This is
fundamentally different from `codex_exec`, where Codex runs autonomously via
CLI and produces structured result contracts automatically.

## codex exec vs codex tui

| Aspect                   | codex_exec (default)                 | codex_tui_goal (manual fallback)            |
|--------------------------|--------------------------------------|---------------------------------------------|
| Execution model          | Automatic via codex exec CLI         | Interactive PTY session                     |
| Operator required        | No                                   | Yes (human at the terminal)                 |
| Result contract          | Auto-generated (result.json + md)    | Operator must write result.json and result.md |
| Verification             | Auto-executed                        | Operator must run and document verification |
| Default for tasks        | Yes                                  | No (explicit opt-in via metadata)           |
| Superpowers required     | No                                   | Yes (for `/goal` prompt to stick)           |
| PTY prerequisite         | None (pipe IO)                       | node-pty or script(1)                       |
| Failure mode             | Auto-retry / repair                  | Terminal (failed/timed_out, not review)     |

## PTY Prerequisites

TUI sessions require a PTY (pseudo-terminal).  Two mechanisms are available,
checked in order:

### 1. node-pty (preferred)

Install the `node-pty` native addon:

```bash
cd backend && npm install node-pty
```

If node-pty is available, sessions use a full 120-column × 40-row PTY.

### 2. script(1) fallback

If node-pty is not available, the adapter falls back to the system `script(1)`
command, which provides basic terminal emulation.  This is available on all
Linux and macOS systems.

### PTY Availability Check

The exported `checkPtyAvailability()` function returns a structured report:

```js
{
  node_pty: false,        // node-pty not installed
  node_pty_error: "Cannot find module 'node-pty'",
  script: true,           // script(1) found on PATH
  available: true,        // some mechanism is usable
  diagnostic: "Script fallback via script(1)",
  detail: "node-pty is NOT installed; using script(1) fallback..."
}
```

When neither mechanism is available, the task fails immediately with
`status: "failed"` and a clear diagnostic message.  It does **not** enter
`waiting_for_review`.

## Enabling TUI Mode

Set `GPTWORK_CODEX_TUI_ENABLED=true` in the runtime environment, and mark the
task metadata with `codex_execution_provider: "codex_tui_goal"`.

## Evidence Artifacts

A TUI session produces these durable artifacts under the goal's workspace:

| Artifact | Path | Required |
|----------|------|----------|
| Session record | `.gptwork/codex-tui-sessions/{sessionId}.json` | Yes (produced automatically) |
| Session log    | `.gptwork/codex-tui-sessions/{sessionId}.log`   | Yes (produced automatically) |
| Result JSON    | `.gptwork/goals/{goalId}/result.json`            | Yes (operator must write) |
| Result Markdown| `.gptwork/goals/{goalId}/result.md`              | Yes (operator must write) |
| Change evidence| `git diff / git log`                             | Expected for code-change tasks |
| Verification   | `.gptwork/goals/{goalId}/verification.json`      | Auto-written by task-verifier |

### Evidence Writeback Pipeline

When the operator produces `result.json` and `result.md`, the evidence enters
the standard pipeline:

```
collectCodexTuiCompletion()
    → writebackTuiEvidence()
        → normalizeOperationEvidence()
            → decideTaskFinalState()
                → normalizeToUnifiedDecision()
```

This is the same pipeline that `codex_exec` uses, so review packets and
acceptance decisions work identically for both providers.

## Failure / Recovery Behavior

### Scenario: PTY unavailable (no node-pty, no script)

Task enters `failed` status immediately with `pty_report` diagnostic.
Operator must install node-pty or ensure script(1) is on PATH.

### Scenario: Evidence timeout

When `result.json` is not written within the evidence wait window
(default 120s), the task enters `timed_out` status.  No `waiting_for_review`
state is entered without at least minimal durable evidence.

### Scenario: Evidence collected with blockers

If `result.json` exists but is missing required fields (commit, tests,
changed_files), the evidence writeback produces structured blockers and the
task enters `failed` or `waiting_for_review` depending on severity.

### Recovery

1. Install node-pty if missing.
2. Restart the TUI session (task retry or resume).
3. Write `result.json` and `result.md` with complete evidence.
4. Rerun evidence collection / verification.

## Testing

Run the dedicated TUI/PTY evidence tests:

```bash
cd backend && node --test test/codex-tui-evidence-pty.test.mjs
```

Test coverage:
- `checkPtyAvailability` when node-pty is absent
- Error codes and messages for unavailable PTY
- Evidence cycle timeout → `timed_out` status
- Evidence cycle ready → `ready` status
- Completion collection with/without result files
- Evidence writeback pipeline with blockers
- Superpowers plugin preflight check
