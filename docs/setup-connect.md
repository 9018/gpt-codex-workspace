# GPTWork Setup and Connection Guide

> **Delivery System Status**: The core delivery pipeline (create → queue → worktree → execute → verify → complete) is **integrated** into the main flow. All setup, configuration, and connection procedures below apply to the fully integrated system. The repair loop and serial integration queue are **integrated** — tasks exceeding the repair budget enter `waiting_for_review` for manual disposition. The delivery pipeline is fully shipped with P0-MA12 convergence.

---

This guide walks you through the recommended path from clone to ChatGPT connection.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Install](#quick-install)
- [Configuration](#configuration)
- [Connection Options](#connection-options)
- [Verification](#verification)
- [GitHub Issues Fallback](#github-issues-fallback)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js >= 22
- npm
- Access to the MCP backend server (localhost or LAN)

---

## Quick Install (Productized Flow)

### One-Step Initialization

```bash
cd backend
npm install
npm link
gptwork init
```

`gptwork init` creates all required directories, templates, and runs a full diagnostic suite:

| Check | What it validates |
|-------|-------------------|
| Git repo | Detectable via `git rev-parse` |
| `.gptwork/` | Directory structure (goals, reports, workflows) |
| `runtime.env` | Exists and validated against `runtime.env.example` |
| Project context | `.gptwork/project.md` and `.gptwork/project.env` |
| Repo registry | `.gptwork/repos.json` format and content |
| npm deps | `node_modules` present after install |
| Required dirs | `data/workspaces/`, `data/logs` |
| Git worktree | Clean or dirty state |
| Codex CLI | Available in PATH |

Initialization NEVER overwrites existing configuration. Missing items are reported with fix hints.

### Automated Repair

```bash
gptwork fix
```

Creates missing directories, templates, and installs deps. Does NOT overwrite existing config.
> **Note**: `gptwork fix` will NOT proceed if the git working tree has uncommitted changes.

### Traditional Setup

```bash
gptwork setup
```

Creates `.gptwork/runtime.env` with safe defaults. Does not overwrite existing secrets.

### Runtime Environment Variables

All configuration lives in `.gptwork/runtime.env` (excluded from git via `.gitignore`).

| Variable | Default | Description |
|----------|---------|-------------|
| `GPTWORK_HOST` | `127.0.0.1` | Server bind address |
| `GPTWORK_PORT` | `8787` | Server port |
| `GPTWORK_TOOL_MODE` | `standard` | Tool exposure mode (minimal/standard/operator/codex/full) |
| `GPTWORK_CODEX_EXEC_TIMEOUT` | `3600` | Codex execution timeout in seconds |
| `GPTWORK_AGENT_BACKEND` | `codex_exec` | Default execution backend (`codex_exec`, `local_command`, `null`) |
| `GPTWORK_AGENT_ROLE_BACKENDS` | — | Comma-separated role routing, for example `verifier=local_command,reviewer=null` |
| `GPTWORK_AGENT_LOCAL_COMMAND` | — | Shell command for the `local_command` backend |
| `GPTWORK_AGENT_ROLE_COMMANDS` | — | Role command overrides separated by `||`, for example `verifier=npm test` |
| `GPTWORK_GITHUB_ENABLED` | `false` | Enable GitHub Issues sync |
| `GPTWORK_GITHUB_REPO` | — | GitHub repo for issue sync |
| `GPTWORK_GITHUB_TOKEN` | — | GitHub token |
| `GPTWORK_BARK_ENABLED` | — | Enable Bark push notifications |
| `GPTWORK_BARK_URL` | — | Bark endpoint URL |
| `GPTWORK_BARK_KEY` | — | Bark API key |

Example `.gptwork/runtime.env`:

```bash
GPTWORK_HOST=127.0.0.1
GPTWORK_PORT=8787
GPTWORK_TOOL_MODE=standard
GPTWORK_REQUIRE_AUTH=true
GPTWORK_CODEX_EXEC_TIMEOUT=3600
GPTWORK_AGENT_BACKEND=codex_exec
# GPTWORK_AGENT_ROLE_BACKENDS=verifier=local_command,reviewer=null
# GPTWORK_AGENT_LOCAL_COMMAND=npm --prefix backend test

# GitHub Issues sync (optional)
# GPTWORK_GITHUB_ENABLED=true
# GPTWORK_GITHUB_REPO=your-org/your-repo

# Bark notifications (optional)
# GPTWORK_BARK_ENABLED=true
# GPTWORK_BARK_URL=https://api.example.com/push
# GPTWORK_BARK_KEY=your-bark-key
```

> **Important:** Never commit secrets to git. The `.gptwork/runtime.env` file is already in `.gitignore`.

---

## Connection Options

### Option 1: Local-only (LAN)

The MCP server binds to `127.0.0.1:8787` by default.
This works for:

- **Codex plugin** running on the same machine or same LAN.
- **Testing and development** before setting up a public endpoint.

```bash
gptwork start
```

Codex can connect via:
```
http://127.0.0.1:8787/mcp
```

ChatGPT cannot reach a localhost endpoint directly.

### Option 2: Reverse Proxy (recommended for ChatGPT)

Set up a reverse proxy (nginx, Caddy, or Cloudflare Tunnel):

1. Update runtime.env:
   ```bash
   gptwork settings set GPTWORK_HOST 0.0.0.0
   ```

2. Point your reverse proxy to `http://127.0.0.1:8787`.

3. In ChatGPT, add an MCP connector with URL:
   ```
   https://mcp.your-domain.com/mcp/dev-token
   ```
   Replace `dev-token` with your actual API token.
   Authentication is path-based: the suffix after `/mcp/` is extracted as the bearer token.

### Option 3: GitHub Issues (no reverse proxy needed)

See [GitHub Issues Fallback](#github-issues-fallback) below.

---

## Verification

After starting the server, run these checks:

```bash
# Quick health check
curl http://127.0.0.1:8787/health

# Full productized check (recommended entry point)
gptwork init

# Local diagnostics with enhanced checks
gptwork doctor --local

# Self-test (9 check categories)
gptwork self-test --local

# Full pre-release verification
npm run release:check
```

### What to Check

| Check | Expected |
|-------|----------|
| `gptwork doctor --local` | Shows repo root, workspace root, tool mode, codex exec timeout=3600, GitHub/Bark status |
| `gptwork self-test --local` | 9 checks: tool mode matrix, shell_exec boundary, timeout 3600, widget resource, E2E script, GitHub, Bark, config sources, state store |
| `curl http://127.0.0.1:8787/health` | `{"ok":true,"service":"gptwork-mcp","time":"..."}` |
| `gptwork connect --local` | Shows local MCP URL, ChatGPT connector example, and connectivity option explanations |

---

## GitHub Issues Fallback

When you don't have a public HTTPS endpoint for ChatGPT, you can use GitHub Issues:

1. **Set environment variables:**
   ```bash
   GPTWORK_GITHUB_ENABLED=true
   GPTWORK_GITHUB_REPO=your-org/your-repo
   GPTWORK_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
   ```

2. **How it works:**
   - ChatGPT creates GitHub Issues with label `gptwork-task`.
   - The backend polls GitHub Issues periodically and syncs them to tasks.
   - Codex executes tasks and writes results back.
   - ChatGPT reads the updated issue for results.

3. **Limitations:**
   - No real-time interaction — delays depend on sync interval.
   - Requires GitHub repo access for both ChatGPT and the backend.
   - Chat history is less rich than direct MCP.

---

## Troubleshooting

### "MCP tools not showing in ChatGPT"

- Verify server is running: `curl http://127.0.0.1:8787/health`
- Check the connector URL format: `https://.../mcp/<token>`
- Ensure `GPTWORK_TOOL_MODE` is appropriate for your use case

### "gptwork_self_test shows warnings"

Warnings are expected for optional features:

- **GitHub WARN**: GitHub Issues sync is optional. Configure only if needed.
- **Bark WARN**: iOS push notifications are optional. Configure only if needed.
- **Timeout WARN**: Verify `GPTWORK_CODEX_EXEC_TIMEOUT=3600` in runtime.env if non-3600 value is intentional.

### "Connection refused"

- Make sure the server is running: `gptwork start`
- Check port binding: default is `127.0.0.1:8787`
- For remote access, set `GPTWORK_HOST=0.0.0.0`

### "npm run release:check fails"

- Fix syntax errors first: `npm run check:syntax`
- Fix import issues: `npm run check:imports`
- Fix acceptance tests: `npm run test:e2e-acceptance`
- Then run `npm run release:check` again
