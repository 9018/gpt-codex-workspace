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

- `codex_tui_goal` is the product-default autonomous execution provider.
- `codex_exec` is also a first-class autonomous provider and is used only when explicitly selected or when typed provider availability policy permits it.
- TUI does not depend on routine operator interaction: GPTWork drives task dispatch, continuation, evidence collection, acceptance, repair, resume, and cancellation.
- `GPTWORK_AGENT_ROLE_BACKENDS` remains available for explicit per-role overrides such as deterministic local verification.
- New builder/deploy/admin tasks enforce pipeline gates before closure.

## Autonomous TUI Runtime Settings

```bash
# GPTWORK_CODEX_TUI_ENABLED=true  # default; set false only to disable TUI explicitly
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
  - [Closed-Loop Automation](../docs/closed-loop-automation.md) — Goal → Task → Agent → Evidence → Acceptance → Replan/Continue/Stop 闭环设计
  - [Closure and Acceptance](../docs/closure-acceptance.md) — 验收门、合同验证、闭环节点判定详解
- [Chinese main README](../README.zh-CN.md)
- [Release gate](../docs/delivery/release-gate.md)
- [Architecture](../docs/architecture.md)
- [Operations](../docs/operations.md)
- [Setup and connection](../docs/setup-connect.md)
