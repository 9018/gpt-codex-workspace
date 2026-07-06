# GPTWork Launch Initialization Configuration

> P0-MA10 deliverable. Captures the final productization baseline, startup/default
> configuration, and one-shot production initialization procedure for GPTWork.

**Status:** Finalized
**Canonical baseline:** `c4ec54cd4c74641a50fabd0c4e98ae6f70a81693`
**Canonical branch:** `main`

---

## 1. Productization Baseline

### 1.1 Repository Layout

```
gpt-codex-workspace/
  backend/              # MCP backend (Node.js ESM)
    bin/                # CLI binary entry
    data/               # Example state files
    scripts/            # Release, syntax, init scripts
    src/                # Source modules (~120 modules)
    systemd/            # systemd service unit
    test/               # Test suites (~1500+ tests)
  bin/                  # Root-level tooling
  data/                 # Runtime data
  docs/                 # Architecture, operations, delivery docs
  plugins/              # Plugin directory
  .gptwork/             # Goal files, runtime config, workflows
    project.md          # Project classifier context
    runtime.env.example # Runtime environment template
    repos.json          # Repository registry
```

### 1.2 Runtime Stack

| Layer | Component | Language/Dependency |
|---|---|---|
| MCP Server | `gptwork-server.mjs` | Node.js >= 22, ESM |
| HTTP Transport | `http-handler.mjs` | Built-in Node.js HTTP |
| State Store | `state-store.mjs` | JSON file persistence |
| Worker | `codex-worker.mjs` | Subprocess orchestration |
| Queue | `goal-queue.mjs` | In-process queue |
| Git Tools | `git-remote-*` | Native Git CLI |
| Task Graph | `task-graph-state.mjs` | JSON state machine |
| GitHub Sync | `github-adapter.mjs` | GitHub API |
| Context Index | `zvec` (optional) | Vector store |
| Notifications | `bark-notifier-*` | Bark push API |
| Deployment | `safe-restart-*` | Two-phase restart |
| Delivery Check | `release-delivery-check.mjs` | Multi-step verify |
| Review | `review-packet-builder.mjs` | Compact review |
| Closure | `task-closure-decider.mjs` | Deterministic closure |
| Integration | `integration-queue.mjs` | ff-only merge |
| Agent Backends | `agent-execution-backends.mjs` | codex_exec, local, null |
| TUI Provider | `codex-tui-*` | Optional TUI |
| Pipeline | `pipeline-orchestration.mjs` | Hook orchestration |
| Worktree | `task-worktree-manager.mjs` | Per-task worktrees |
| Acceptance | `acceptance-agent.mjs` | Contract-aware |

### 1.3 Entry Points

| Purpose | Script / Command |
|---|---|
| Production server | `node backend/src/cli.mjs` |
| CLI setup | `gptwork setup` |
| Run tests | `cd backend && npm test` |
| Syntax check | `cd backend && npm run check:syntax` |
| Import check | `cd backend && npm run check:imports` |
| Release gate | `cd backend && npm run release:delivery-check` |
| E2E delivery | `cd backend && npm run test:e2e-delivery` |
| Production init | `cd backend && node scripts/init-production.mjs` |
| Smoke test | `cd backend && node scripts/e2e-delivery-smoke.mjs` |

### 1.4 Build and Package

| File | Purpose |
|---|---|
| `backend/package.json` | npm package definition, scripts, dependencies |
| `backend/systemd/gptwork-mcp.service` | systemd unit for production |
| `.gptwork/runtime.env.example` | Runtime environment template (safe to commit) |
| `.gptwork/runtime.env` | Runtime environment (NOT committed) |

---

## 2. Startup / Default Configuration

### 2.1 Environment Configuration

The primary configuration mechanism is environment variables, loaded with
the following precedence:

1. **Process environment** (`process.env`) — highest priority
2. **`runtime.env` file** — fills in unset variables
3. **Code defaults** — lowest priority

Copy the template to create a runtime config:

```bash
cp .gptwork/runtime.env.example .gptwork/runtime.env
# Edit .gptwork/runtime.env to set production values
```

### 2.2 Core Server Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_HOST` | `127.0.0.1` | Server bind address |
| `GPTWORK_PORT` | `8787` | Server listen port |
| `GPTWORK_WORKSPACE_ROOT` | `./data/workspaces/default` | Workspace data root |
| `GPTWORK_STATE_PATH` | `.gptwork/state.json` | Persistent state file |
| `GPTWORK_TOKENS` | `dev-token,test` | API tokens (comma-separated) |
| `GPTWORK_REQUIRE_AUTH` | `true` | Require auth for MCP |

### 2.3 Worker Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_CODEX_WORKER` | `false` | Enable codex worker loop |
| `GPTWORK_CODEX_WORKER_INTERVAL_MS` | `5000` | Worker poll interval |
| `GPTWORK_CODEX_WORKER_CONCURRENCY` | `4` | Max concurrent tasks |
| `GPTWORK_CODEX_EXEC_TIMEOUT` | `3600` | Codex execution timeout (s) |

### 2.4 Agent Backend Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_AGENT_BACKEND` | `codex_exec` | Default agent backend |
| `GPTWORK_AGENT_ROLE_BACKENDS` | (none) | Per-role overrides |
| `GPTWORK_AGENT_COMMAND_TIMEOUT` | `60` | Command timeout (s) |

### 2.5 Notification Settings (Bark)

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_BARK_ENABLED` | `true` | Enable push notifications |
| `GPTWORK_BARK_KEY` | (none) | API key for Bark |
| `GPTWORK_BARK_GROUP` | `gptwork` | Notification group |

### 2.6 GitHub Integration (Optional)

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_GITHUB_ENABLED` | `false` | Auto-detected if repo+token set |
| `GPTWORK_GITHUB_REPO` | (none) | Owner/repo for issue sync |
| `GPTWORK_GITHUB_TOKEN` | (none) | GitHub PAT |
| `GPTWORK_GITHUB_SYNC_LIMIT` | `20` | Max issues per tick |

### 2.7 Performance and Limits

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_SHELL_TIMEOUT` | `60` | Shell command timeout (s) |
| `GPTWORK_MAX_OUTPUT_BYTES` | `200000` | Max output bytes |
| `GPTWORK_MAX_READ_BYTES` | `200000` | Max file read bytes |
| `GPTWORK_CODEX_CONCURRENCY` | `4` | Codex concurrency limit |

---

## 3. One-Shot Production Initialization Procedure

### 3.1 Prerequisites

- Node.js >= 22
- Git (for worktree management and repository operations)
- (Optional) `codex` CLI for `codex_exec` backend
- (Optional) `zvec` binary for context vector indexing
- (Optional) Bark app/API key for push notifications
- (Optional) GitHub PAT for issue sync

### 3.2 Initialization Steps

```bash
# 1. Clone the repository
git clone git@github.com:9018/gpt-codex-workspace.git
cd gpt-codex-workspace

# 2. Check out the launch baseline
git checkout c4ec54cd4c74641a50fabd0c4e98ae6f70a81693

# 3. Install dependencies and link CLI
cd backend && npm install && npm link

# 4. Productized initialization (creates dirs, templates, validates)
gptwork init
# Run gptwork fix if issues are reported

# 5. Run release gate to confirm baseline
npm run release:delivery-check

# 6. Start the server (manual or systemd)
# Manual:
node src/cli.mjs

# systemd:
cp systemd/gptwork-mcp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gptwork-mcp
```

### 3.3 Post-Init Verification

After starting the server, verify operational readiness:

```bash
# Health check
curl -s http://localhost:8787/health | jq .

# Full productized check
gptwork init

# Runtime diagnostics with enhanced checks
gptwork doctor --local

# Quick self-test
gptwork self_test
```

Expected health response:

```json
{
  "status": "ok",
  "timestamp": "...",
  "version": "...",
  "commit": "c4ec54cd4c74641a50fabd0c4e98ae6f70a81693",
  "uptime_seconds": ...
}
```

---

## 4. Default State Seed

When starting with an empty state file, GPTWork initializes with:

- No pre-existing goals or tasks
- Empty repository registry
- No active locks
- Empty goal inbox
- No context index until first use

The default state example is available at:

```bash
cat data/state.example.json
```

---

## 5. Lifecycle Integration Points

| Hook | Trigger | Purpose |
|---|---|---|
| `hook:setup` | `gptwork setup` | Initial setup |
| `hook:start` | Server start | Runtime bootstrap |
| `hook:shutdown` | Server stop | Graceful shutdown |
| `hook:task:created` | Task creation | Notification |
| `hook:task:completed` | Task completion | Post-completion hooks |
| `hook:goal:completed` | Goal completion | Follow-up planning |

---

*End of launch initialization configuration. This document is part of the
P0-MA10 closure acceptance deliverable.*
