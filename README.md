# GPT-Codex Workspace

[中文主文档](README.zh-CN.md) | English

GPTWork is a backend MCP service that coordinates ChatGPT, Codex, and project workspaces. ChatGPT creates bounded goals, GPTWork manages task state/queue/context/evidence, and Codex executes changes in isolated worktrees before GPTWork verifies, accepts, integrates, and closes the work.

The detailed project documentation is maintained in Chinese at [README.zh-CN.md](README.zh-CN.md). This English README is the current operator/product entry and should stay aligned with the release gates.

## Current Product Shape

- **Primary entry**: ChatGPT should start with `open_project_context`, then use `create_encoded_goal` for implementation, deployment, maintenance, or multi-step work.
- **Bounded context**: Codex starts from `.gptwork/goals/<goal_id>/codex.entry.md` and prefers `context.bundle.md` over full goal context when a bundle exists.
- **Compact review**: Review should use `get_task_review_packet` and `get_task_acceptance_bundle`, not full transcripts or large diffs.
- **Default automation path**: all pipeline roles default to `codex_exec` through the canonical `ROLE_BACKEND_DEFAULTS` source. Role-specific overrides via `GPTWORK_AGENT_ROLE_BACKENDS` are explicit operator configuration, not product defaults.
- **Codex TUI**: `codex_tui_goal` is an explicit operator fallback only. GPTWork never silently downgrades automatic execution to TUI.
- **Pipeline gates**: new builder/deploy/admin tasks enforce pipeline gates before closure. Missing required artifacts block closure or send the task to review/repair.
- **Product diagnostics**: `product_status`, `runtime_status`, `worker_status`, and `gptwork_doctor` show commit/runtime/queue/blocker/review/TUI status without requiring raw state reads.
- **Tool-result v5 contract**: model-facing tool results are bounded. Full card payloads remain in card metadata; only controlled compatibility fields are exposed to the model.

Important delivery boundaries: `branch_pushed != merged`, `pr_opened != merged`, `merged != deployed`, and `health 200 != running expected commit`. `quality_notes` and `non_blocking_followups` do not block current task closure.

## Quick Start

```bash
cd backend
npm install
npm link
gptwork init
gptwork start
```

In another shell:

```bash
cd backend
gptwork doctor --local
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

For production initialization:

```bash
cd backend
gptwork init --production
```

Production mode validates worker enablement, role/backend settings, Codex exec settings, workspace configuration, vector-store configuration, and integration mode before the environment is treated as ready.

## Runtime Configuration Highlights

```bash
# Product default: all roles use automatic Codex execution.
GPTWORK_AGENT_BACKEND=codex_exec

# Optional explicit per-role override examples.
# GPTWORK_AGENT_ROLE_BACKENDS=verifier=local_command,reviewer=local_command
# GPTWORK_AGENT_ROLE_COMMANDS=verifier=npm --prefix backend test||reviewer=node scripts/review.mjs

# Optional explicit TUI fallback. It still requires task metadata opt-in.
# GPTWORK_CODEX_TUI_ENABLED=true
# GPTWORK_CODEX_TUI_COMMAND=codex
# GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS=30000
# GPTWORK_CODEX_TUI_SESSION_ROOT=/path/to/workspace
# GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=true
```

## Verification and Release Gates

Fast local checks:

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

Release candidates should pass all product gates from a clean worktree:

```bash
cd backend
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

`release:delivery-check` covers the delivery system and compatibility surface, `release:tui-first-loop-gate` covers the TUI-first loop smoke path, and `release:check` is the baseline package release gate.

## Main Docs

- [中文主文档](README.zh-CN.md)
- [Current status](docs/current-status.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Release gate](docs/delivery/release-gate.md)
- [Context and worktree contract](docs/delivery/context-and-worktree-contract.md)
- [Setup and connection](docs/setup-connect.md)
- [Goal queue](docs/goal-queue.md)
- [GitHub fallback](docs/github-fallback.md)

## Security

Do not put real tokens, `.env` contents, runtime secrets, GitHub tokens, notification keys, raw transcripts, shell snapshots, or durable memory contents in README files, docs, goal payloads, results, or Issues. Use local ignored runtime configuration and secret stores.

## License

MIT

## Workstream Productization

GPTWork includes a complete Workstream productization contract (G1–G7) covering:

- **Workstream identity and CRUD** with access control and execution/acceptance policies
- **Context links** for ChatGPT conversations, Codex threads, and GitHub issues
- **DAG orchestration**: fan-out/join, capacity limits, topological sort
- **Drift/stall detection**: wrong phase/scope, stale progress, dead TUI, stale locks
- **Acceptance controller**: verdict (passed/failed/partial/blocked), repair budget (max 2), ChatGPT escalation
- **Tick controller**: bounded 5-transition advancement per cycle
- **Hourly supervisor contract**: drift correction, stall recovery, direct edit preference, idempotency
- **Apps SDK card view**: operations dashboard for Workstream health

Verification commands:

```bash
# E2E productization + hourly supervisor tests (25 tests)
node --test backend/test/e2e-workstream-productization.test.mjs backend/test/workstream-hourly-supervisor.test.mjs

# All workstream tests
node --test backend/test/workstream-*.test.mjs

# Full test suite
npm --prefix backend test
```

Full documentation: [docs/workstreams/tui-productization/README.md](docs/workstreams/tui-productization/README.md).
