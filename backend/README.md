# GPTWork Backend

This directory contains the GPTWork MCP backend service, CLI, worker loop, release gates, and test suites.

## Quick Start

```bash
npm install
npm link
gptwork init
gptwork start
```

Local diagnostics:

```bash
gptwork doctor --local
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

Production initialization:

```bash
gptwork init --production
```

Production mode validates worker enablement, backend routing, Codex exec settings, workspace settings, vector-store configuration, and integration mode.

## Product Defaults

- `GPTWORK_AGENT_BACKEND=codex_exec` is the product default.
- All pipeline roles default to `codex_exec` through `ROLE_BACKEND_DEFAULTS`.
- `GPTWORK_AGENT_ROLE_BACKENDS` is only for explicit per-role overrides, for example `verifier=local_command,reviewer=local_command`.
- `codex_tui_goal` is an explicit operator fallback. It requires runtime enablement and task metadata opt-in; GPTWork does not silently route automatic work to TUI.
- New builder/deploy/admin tasks enforce pipeline gates before closure.

## Optional TUI Runtime Settings

```bash
# GPTWORK_CODEX_TUI_ENABLED=true
# GPTWORK_CODEX_TUI_COMMAND=codex
# GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS=30000
# GPTWORK_CODEX_TUI_SESSION_ROOT=/path/to/workspace
# GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=true
```

The TUI session manager records explicit `workspaceRoot` / `session_store_root` metadata so session files are stored under the configured workspace root rather than accidentally under a task cwd.

## Release Gates

Fast development check:

```bash
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

Release candidates should pass all product gates from a clean worktree:

```bash
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

## Important Docs

- [Root README](../README.md)
- [Chinese main README](../README.zh-CN.md)
- [Release gate](../docs/delivery/release-gate.md)
- [Architecture](../docs/architecture.md)
- [Operations](../docs/operations.md)
- [Setup and connection](../docs/setup-connect.md)
