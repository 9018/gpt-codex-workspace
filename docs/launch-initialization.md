# GPTWork Launch Initialization Configuration

> Captures the productized initialization baseline, startup/default
> configuration, and production initialization procedure for GPTWork.
> Updated for Production Init Config Hardening (P0, commit `2d60458`).

**Status:** Current
**Canonical baseline:** `2d60458d37c5ea552863db85d08cd5db61c3abe1` (verify current with `git rev-parse HEAD`)
**Canonical branch:** `main`

> **Baseline verification:** This hash documents the baseline used during the
> Production Init Config Hardening deliverable. The actual deployment may be on
> a newer commit. To verify the running commit:
> ```bash
> gptwork doctor --local          # shows current_head diagnostics
> gptwork init --production       # validates production profile incl. baseline
> git rev-parse HEAD
> ```
> If the current HEAD differs from the documented baseline, run:
> ```bash
> gptwork doctor --local   # check current_head diagnostic
> gptwork init --production  # validate full production profile
> ```

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

| Component | Module | Language |
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
| Delivery Check | `release-delivery-check.mjs` | Profile-aware delivery gate |
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
| CLI setup / runtime.env generation | `gptwork setup` |
| One-step init & diagnostics | `gptwork init` |
| Automated repair | `gptwork fix` |
| Detailed diagnostics | `gptwork doctor --local` |
| Self-test | `gptwork self-test --local` |
| Run tests | `cd backend && npm test` |
| Syntax check | `cd backend && npm run check:syntax` |
| Import check | `cd backend && npm run check:imports` |
| Delivery release gate | `cd backend && npm run release:delivery-check` |
| E2E delivery | `cd backend && npm run test:e2e-delivery` |
| TUI-first release gate | `cd backend && npm run release:tui-first-loop-gate` |
| Production init (legacy) | `cd backend && node scripts/init-production.mjs` |
| Smoke test | `cd backend && node scripts/e2e-delivery-smoke.mjs` |
| Baseline package release gate | `cd backend && npm run release:check` |

### 1.4 Build and Package

| File | Purpose |
|---|---|
| `backend/package.json` | npm package definition, scripts, dependencies |
| `backend/systemd/gptwork-mcp.service` | systemd unit for production |
| `.gptwork/runtime.env.example` | Runtime environment template **(safe to commit)** |
| `.gptwork/runtime.env` | Runtime environment (NOT committed) |
| `.gptwork/project.md` | Project context classifier |
| `.gptwork/project.env` | Project environment context |
| `.gptwork/repos.json` | Repository registry |

---

## 2. Startup / Default Configuration

### 2.1 Environment Configuration

The primary configuration mechanism is environment variables, loaded with
the following precedence:

1. **Process environment** (`process.env`) — highest priority, always wins
2. **`runtime.env` file** — fills in unset variables (dotenv-style KEY=VALUE)
3. **Code defaults** — lowest priority, built into each module

The runtime.env file uses a simple KEY=VALUE format. Lines starting with `#`
are ignored. Empty values are treated as unset.

Copy the template to create a runtime config:

```bash
cp .gptwork/runtime.env.example .gptwork/runtime.env
```

Or use the CLI:

```bash
gptwork setup      # generates runtime.env with defaults
gptwork init       # checks and reports any issues
gptwork fix        # automated repair for common issues
```

### 2.2 Core Server Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_HOST` | `127.0.0.1` | Server bind address |
| `GPTWORK_PORT` | `8787` | Server listen port |
| `GPTWORK_WORKSPACE_ROOT` | `./data/workspaces/default` | Workspace data root |
| `GPTWORK_STATE_PATH` | `<workspace>/.gptwork/state.json` | State file path |
| `GPTWORK_RUNTIME_ENV_FILE` | `.gptwork/runtime.env` | Path to env file |
| `GPTWORK_TOOL_MODE` | `standard` | Tool exposure (standard/minimal/operator/codex/full) |
| `GPTWORK_TOKENS` | `dev-token,test` | API tokens (comma-separated) |
| `GPTWORK_REQUIRE_AUTH` | `true` | Require auth for MCP |
| `GPTWORK_WRITE_MODE` | `workspace` | Write permission scope |
| `GPTWORK_SHELL_MODE` | `full` | Shell command scope |
| `GPTWORK_SHELL_TRANSCRIPT` | `compact` | Shell transcript mode |

### 2.3 Worker Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_CODEX_WORKER` | `false` | Enable worker loop (required for production) |
| `GPTWORK_CODEX_WORKER_INTERVAL_MS` | `5000` | Worker poll interval |
| `GPTWORK_CODEX_WORKER_CONCURRENCY` | `4` | Max concurrent tasks |
| `GPTWORK_CODEX_EXEC_TIMEOUT` | `3600` | Execution timeout (seconds) |
| `GPTWORK_CODEX_EXEC_ARGS` | `--yolo --skip-git-repo-check` | Extra args for codex exec |
| `GPTWORK_CODEX_CONCURRENCY` | `4` | Concurrency limit |
| `GPTWORK_CODEX_STALL_THRESHOLD_SECONDS` | `600` | Stall threshold |

### 2.4 Agent Backend Settings

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_AGENT_BACKEND` | `codex_exec` | Default backend |
| `GPTWORK_AGENT_ROLE_BACKENDS` | (none) | Optional per-role overrides (comma-separated); leave unset for product defaults |
| `GPTWORK_AGENT_LOCAL_COMMAND` | (none) | Default local command |
| `GPTWORK_AGENT_ROLE_COMMANDS` | (none) | Per-role command overrides (||-separated) |
| `GPTWORK_AGENT_COMMAND_TIMEOUT` | `60` | Command timeout (seconds) |
| `GPTWORK_AGENT_COMMAND_FIRST_OUTPUT_TIMEOUT` | `0` | First output deadline (0=no limit) |
| `GPTWORK_AGENT_COMMAND_NO_PROGRESS_TIMEOUT` | `0` | No-progress deadline (0=no limit) |

### 2.5 Notification Settings (Bark)

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_BARK_ENABLED` | (empty) | Enable push notifications |
| `GPTWORK_BARK_URL` | (none) | Server URL |
| `GPTWORK_BARK_KEY` | (none) | API key |
| `GPTWORK_BARK_GROUP` | `gptwork` | Notification group |
| `GPTWORK_BARK_SOUND` | (none) | Sound override |
| `GPTWORK_BARK_LEVEL` | (none) | Priority level |
| `GPTWORK_BARK_ICON_URL` | (none) | Notification icon |
| `GPTWORK_BARK_CLICK_URL` | (none) | Notification click action |
| `GPTWORK_BARK_BADGE` | (none) | Badge count |

### 2.6 GitHub Integration (Optional)

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_GITHUB_ENABLED` | `false` | Enable GitHub issue sync |
| `GPTWORK_GITHUB_REPO` | (none) | Owner/repo for issue sync |
| `GPTWORK_GITHUB_TOKEN` | (none) | GitHub PAT |
| `GPTWORK_GITHUB_SYNC_LIMIT` | `20` | Max issues per tick |

### 2.7 Performance and Limits

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_SHELL_TIMEOUT` | `60` | Shell command timeout (seconds) |
| `GPTWORK_MAX_OUTPUT_BYTES` | `200000` | Max shell output bytes |
| `GPTWORK_MAX_READ_BYTES` | `200000` | Max file read bytes |
| `GPTWORK_MAX_SHELL_OUTPUT_BYTES` | `200000` | Max shell stdout bytes |
| `GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT` | `600` | Recovery command timeout |

### 2.8 Context Index / Vector Store

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_CONTEXT_VECTOR_STORE` | `auto` | Backend (auto/none) |
| `GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS` | `2048` | Max tokens per bundle |
| `GPTWORK_CONTEXT_BUNDLE_MAX_CHUNKS` | `8` | Max chunks per bundle |
| `GPTWORK_CONTEXT_CROSS_GOAL_TOP_K` | `4` | Cross-goal top-K |
| `GPTWORK_CONTEXT_PER_GOAL_TOP_K` | `4` | Per-goal top-K |
| `GPTWORK_CONTEXT_MAX_GOALS_SCANNED` | `20` | Max scanned goals |

### 2.9 Integration & Worktrees

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_INTEGRATION_MODE` | `auto` | Integration (auto/manual) |
| `GPTWORK_ENABLE_TASK_WORKTREES` | `true` | Enable isolated worktrees |

### 2.10 Delivery Recovery

| Variable | Default | Description |
|---|---|---|
| `GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS` | (none) | Pipe-separated recovery commands |
| `GPTWORK_RESULT_RECOVERY_COMMAND_TIMEOUT` | `600` | Timeout per command (s) |

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

# 2. Check out the production baseline
git checkout 2d60458d37c5ea552863db85d08cd5db61c3abe1

# 3. Install dependencies
cd backend && npm install && npm link

# 4. Generate runtime environment
gptwork setup
# Or manually: cp .gptwork/runtime.env.example .gptwork/runtime.env

# 5. Productized initialization (creates dirs, templates, validates)
gptwork init

# 6. (Optional) Validate production profile
gptwork init --production

# 7. Run release gate to confirm baseline
cd backend && npm run release:delivery-check

# 8. Start the server (manual or systemd)
# Manual:
node backend/src/cli.mjs

# systemd:
cp backend/systemd/gptwork-mcp.service /etc/systemd/system/
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

# Production profile validation
gptwork init --production

# Runtime diagnostics with enhanced checks
gptwork doctor --local

# Quick self-test
gptwork self-test --local
```

Expected health response:

```json
{
  "status": "ok",
  "timestamp": "...",
  "version": "...",
  "commit": "2d60458d37c5ea552863db85d08cd5db61c3abe1",
  "uptime_seconds": ...
}
```

---

## 4. Production Profile Initialization

### 4.1 One-Shot Production Init

The `--production` flag enables profile checks specific to production deployments:
`gptwork init --production` (also available via `gptwork doctor --local` report).

The following 9 checks are performed by `runProductionProfile()` in
`backend/src/onboarding-init.mjs`:

| # | Check | Severity | Condition |
|---|-------|----------|-----------|
| 1 | `production_worker` | **blocker** | `GPTWORK_CODEX_WORKER=true` |
| 2 | `role_commands` | **blocker** | `local_command` backend must have role commands configured |
| 3 | `agent_backends` | warn | All backends must be valid (codex_exec/local_command/null) |
| 4 | `release_gate_commands` | warn | `GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS` should be set |
| 5 | `codex_exec_settings` | warn | Timeout >= 3600s, concurrency >= 1 |
| 6 | `current_head` | pass | Reports current HEAD without depending on docs baseline text |
| 7 | `workspace_settings` | warn | `GPTWORK_DEFAULT_REPO` should be set |
| 8 | `context_vector_store` | pass | Should be `auto` (default) or configured |
| 9 | `integration_mode` | pass | Should be `auto` (default) |

### 4.2 Blocking Failures

If `gptwork init --production` or `gptwork doctor --production` reports **blocker** status, those issues
must be resolved before the server is safe to run in production. Both commands exit with a non-zero exit code when blockers are present.

| Check | Blocking Condition | Fix |
|-------|-------------------|-----|
| `production_worker` | Worker disabled | Set `GPTWORK_CODEX_WORKER=true` in `.gptwork/runtime.env` |
| `role_commands` | `local_command` missing role command | Set `GPTWORK_AGENT_ROLE_COMMANDS=verifier=<cmd>\|\|reviewer=<cmd>` |

### 4.3 Non-Blocking Warnings

The following warnings are non-blocking but recommended for production:

| Check | Warning Condition | Recommendation |
|-------|-------------------|----------------|
| `release_gate_commands` | No recovery commands | Set `GPTWORK_DELIVERY_RESULT_RECOVERY_COMMANDS` in runtime.env |
| `codex_exec_settings` | Timeout < 3600s or concurrency < 1 | Set `GPTWORK_CODEX_EXEC_TIMEOUT=3600` |
| `workspace_settings` | `GPTWORK_DEFAULT_REPO` not set | Set via `gptwork settings set GPTWORK_DEFAULT_REPO owner/repo` |
| `agent_backends` | Invalid role backend value | Use only `codex_exec`, `local_command`, or `null` |

### 4.5 Dev vs Production Defaults

| Variable | Dev Default | Production Expected | Rationale |
|---|---|---|---|
| `GPTWORK_CODEX_WORKER` | `false` | `true` | Auto-process tasks |
| `GPTWORK_CODEX_EXEC_TIMEOUT` | `3600` | `>= 3600` | Long-running tasks |
| `GPTWORK_CODEX_CONCURRENCY` | `4` | `4` | Parallel task ceiling |
| `GPTWORK_CODEX_WORKER_INTERVAL_MS` | `5000` | `5000` | Poll frequency |
| `GPTWORK_INTEGRATION_MODE` | `auto` | `auto` | Auto ff-only merges |
| `GPTWORK_CONTEXT_VECTOR_STORE` | `auto` | `auto` | Auto-detect zvec binary |
| `GPTWORK_AGENT_BACKEND` | `codex_exec` | `codex_exec` | Default execution backend |
| `GPTWORK_TOOL_MODE` | `standard` | `standard` | Tool exposure level |

---

## 5. CLI Commands Reference

### 5.1 `gptwork setup`

Generates or inspects the runtime environment file in `GPTWORK_RUNTIME_ENV_FILE`
(default: `.gptwork/runtime.env`):

- If `runtime.env` does not exist: creates a minimal template with core
  settings and commented-out optional sections for GitHub and Bark.
- If `runtime.env` already exists: reports current configuration status
  (which secrets are configured, any missing settings) and next steps.

```bash
gptwork setup
```

### 5.2 `gptwork init`

One-step initialization with diagnostics. Implemented via `runInit()` in
`backend/src/onboarding-init.mjs`.

Creates required directories:
- `.gptwork/goals/`, `.gptwork/reports/`, `.gptwork/workflows/`
- `data/workspaces/default/`, `data/workspaces/archive/`, `data/logs/`

Creates missing template files:
- `.gptwork/project.md` (if missing)
- `.gptwork/project.env` (if missing)
- `.gptwork/runtime.env` (if env + example both exist, copies example)

Runs full check suite (`runFullCheck()`):
- Node.js version (>= 22 recommended)
- Git availability
- Git repository detection
- `.gptwork` directory validity
- `runtime.env` coverage against example
- Project context templates (`project.md`, `project.env`)
- Repo registry (`repos.json`)
- npm dependencies (`node_modules`)
- Required directories
- Dirty repo detection
- Codex CLI availability

With `--production` flag, also runs the 9 production profile checks
(see Section 4.1).

```bash
gptwork init
gptwork init --production
```

### 5.3 `gptwork fix`

Automated repair for common initialization issues. Refuses to run if the
working tree is dirty (commit or stash changes first).

Actions:
1. Creates required directories (same as `init`)
2. Creates `runtime.env` from example, or generates minimal defaults
3. Creates `project.md`, `project.env` if missing
4. Runs `npm install` if `node_modules` is missing
5. Creates `repos.json` from git remote if missing

```bash
gptwork fix
```

### 5.4 `gptwork doctor --local` / `gptwork doctor --production`

Runtime diagnostics with enhanced checks from `printDoctor()`:
- `gptwork doctor --local`: Standard local diagnostics
- `gptwork doctor --production`: Production-specific blocker checks (exits non-zero on blockers)

- Repository root and workspace root
- Runtime env file path and loaded key count
- State file path and tool mode
- Codex exec timeout and concurrency
- Task/goal counts
- GitHub status (configured repo, token presence; secrets redacted)
- Bark status (enabled state; secrets redacted)
- E2E acceptance script path

Enhanced diagnostics (from `onboarding-init.mjs`):
- **env_vs_example**: validates runtime.env coverage against example
- **repo_registry**: checks .gptwork/repos.json validity
- **project_context**: checks project.md and project.env presence
- **codex**: checks codex CLI availability
- **worker**: checks codex worker status
- **github**: checks GitHub configuration

```bash
gptwork doctor --local
```

### 5.5 `gptwork self-test --local`

Runs the self-test tool group (`gptwork_self_test`) which validates:
- State file load and integrity
- Workspace root accessibility
- Git repository connectivity
- Bark configuration (if enabled)
- GitHub configuration (if enabled)
- Runtime env coverage

Produces a summary with PASS/WARN/FAIL per check, timestamp, and
secrets-exposed flag.

```bash
gptwork self-test --local
```

### 5.6 Release Delivery Gate

The profile-aware release gate auto-selects its execution profile based on
changed files:

```bash
cd backend && npm run release:delivery-check
```

| Profile | Triggers | Steps |
|---------|----------|-------|
| **docs** | All changes are documentation-only | `check:imports` only |
| **changed** | Only JS files changed | Syntax check for changed files + imports |
| **fast** | Core delivery modules touched | Focused core checks |
| **full** | Other changes / no base ref | Full suite: all syntax, imports, P0 tests, E2E |

---

## 6. Default State Seed

When starting with an empty state file, GPTWork initializes with:

- No pre-existing goals or tasks
- Empty repository registry
- No active locks
- Empty goal inbox
- No context index until first use
- All goal queues are empty
- No pending integrations

The default state example is available at:

```bash
cat data/state.example.json
```

---

## 7. Runtime Init Review Repair Notes

Updated after the Runtime Init Productization review repair. The runtime init path now enforces these productization rules:

- `process.env` has strict precedence over `.gptwork/runtime.env`, including explicit false values such as `GPTWORK_CODEX_WORKER=false`.
- Productized defaults no longer derive restart paths or Codex home from an author machine path; restart defaults are derived from the effective workspace root.
- `runtime_status` structured output exposes the safe operational fields needed by ChatGPT review: shell/read byte limits, agent backend routing without command text, and default repository settings.
- `current_head` diagnostics report the actual HEAD only; documentation baseline text is informational and does not make production init fail or warn.

Verification command used for this repair:

```bash
cd backend && node --test --test-reporter=dot \
  test/runtime-config.test.mjs \
  test/cli-startup-config.test.mjs \
  test/production-init-doctor.test.mjs
```

Expected result: all selected Runtime Init tests pass.

---

*End of launch initialization configuration.*
