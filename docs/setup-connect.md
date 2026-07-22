# Setup and Connect

> Source-backed as of 2026-07-22.

## Prerequisites

- Node.js capable of running ESM (`backend` is `"type": "module"`)
- npm
- Codex CLI available if you will execute tasks
- For TUI provider: `node-pty` (repo root dependency) or system `script(1)`

## Install

```bash
cd backend
npm install
```

Optional global CLI link:

```bash
npm link
```

Repo root also installs `node-pty` for TUI support:

```bash
cd ..
npm install
```

## Initialize

```bash
gptwork init
# or
gptwork init --production
```

`init` prepares project/runtime scaffolding. Production mode validates stronger operational settings.

Useful repair command:

```bash
gptwork fix
```

## Runtime Config

Preferred file:

```text
.gptwork/runtime.env
```

or workspace-local:

```text
${GPTWORK_WORKSPACE_ROOT}/.gptwork/runtime.env
```

Priority:

```text
process.env > runtime.env > code defaults
```

Minimal local example:

```dotenv
GPTWORK_HOST=127.0.0.1
GPTWORK_PORT=8787
GPTWORK_TOKENS=dev-token,test
GPTWORK_REQUIRE_AUTH=true
GPTWORK_TOOL_MODE=full
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_TUI_ENABLED=true
GPTWORK_EXECUTE_PROVIDER=codex_tui_goal
GPTWORK_ACCEPT_PROVIDER=codex_tui_goal
GPTWORK_WORKSPACE_ROOT=/absolute/path/to/workspace
GPTWORK_STATE_PATH=/absolute/path/to/workspace/.gptwork/state.json
GPTWORK_DEFAULT_REPO_PATH=/absolute/path/to/repo
GPTWORK_DEFAULT_BRANCH=main
```

## Start Server

```bash
gptwork start
```

Expected:

```text
GPTWork MCP listening on http://127.0.0.1:8787/mcp
```

If worker is enabled:

```text
GPTWork safe Codex worker enabled
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Connect

### Local HTTP MCP

Server endpoint:

```text
http://127.0.0.1:8787/mcp
```

Auth:

- `Authorization: Bearer <token>`
- or token embedded in path, depending on deployment

CLI helper:

```bash
gptwork connect --local
gptwork status --local
gptwork doctor --local
```

### Plugin stdio proxy

`plugins/gpt-codex-workspace/mcp/server.mjs` forwards local stdio MCP to:

```text
GPTWORK_MCP_URL   # default https://mcp.gptwork.cc.cd/mcp
GPTWORK_API_TOKEN # bearer token unless URL already contains path token
```

Use this when a client needs stdio MCP but the real service is remote HTTP/SSE.

## First Useful Calls

Typical bootstrap tools:

- `health_check` / `runtime_status` / `worker_status`
- `tool_search` / `tool_describe` when delayed discovery is on
- `create_encoded_goal` or `create_goal`
- `list_tasks` / `get_task` / `get_goal_context`
- `codex_tui_status` if using TUI path

## Common Setup Failures

| Symptom | Likely cause |
|---|---|
| server starts but no tasks move | `GPTWORK_CODEX_WORKER` not true |
| TUI tasks fail immediately | no `node-pty` and no `script(1)` |
| tools missing | `GPTWORK_TOOL_MODE` too narrow, or delayed discovery not queried |
| wrong repo mutated | `GPTWORK_DEFAULT_REPO_PATH` / workspace root mis-set |
| auth errors from proxy | missing `GPTWORK_API_TOKEN` |
