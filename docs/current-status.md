# GPTWork Current Status

Date: 2026-06-16
Status: encoded goal workflow is implemented and tuned for GPTChat -> Codex execution on 10.0.1.103.

## What This Project Is

GPTWork is one backend MCP service used by two clients:

- ChatGPT connects through the public domain and creates shared goals.
- Codex connects through the marketplace plugin and executes those goals in a workspace.
- The backend stores tasks, goals, readable goal files, context, transcript, bundles, and results.

Recommended ChatGPT endpoint:

```text
https://mcp.gptwork.cc.cd/mcp/dev-token
```

Recommended Codex plugin source:

```text
9018/gpt-codex-workspace
```

## Current Ports And Routes

| Item | Value | Purpose |
|---|---|---|
| Backend host | `10.0.1.103` | Remote server running GPTWork |
| Backend port | `8787` | MCP backend HTTP service |
| Public URL | `https://mcp.gptwork.cc.cd/mcp/dev-token` | ChatGPT connector URL, auth mode none |
| LAN MCP URL | `http://10.0.1.103:8787/mcp` | Codex plugin and local testing |
| Workspace root | `/home/a9017/mcp/workspace` | Default hosted workspace root |
| Backend repo | `/home/a9017/mcp/gpt-codex-workspace` | Remote deployment repo |
| Lucky admin | `16601` | Reverse proxy admin UI |
| Legacy ports | None | No legacy port is part of the target architecture |

Path-based auth is the preferred ChatGPT setup. The backend extracts the token from `/mcp/<token>`, so ChatGPT does not need to send an Authorization header.

## Current Workflow

```text
User natural language request
  -> ChatGPT writes a readable preview
  -> ChatGPT builds payload JSON
  -> ChatGPT sends create_encoded_goal(preview_text, payload_base64, assign_to_codex=true, wait_ms=90000)
  -> Backend decodes base64 and saves readable files
  -> Backend creates/links task and assigns Codex
  -> Codex reads .gptwork/goals/<goal_id>/goal.md and context.json
  -> Codex executes, writes result.md, and GPTWork appends the result to the shared transcript
  -> ChatGPT receives an execution snapshot in the same tool response when wait_ms is set
```

Primary ChatGPT entry:

```text
create_encoded_goal
```

Compatibility entries still work:

- `create_goal` remains available.
- `create_task` automatically creates a linked goal.
- `assign_task_to_codex` automatically links old tasks to a goal.
- If `create_task.description` contains a `gptwork.encoded_goal.v1` envelope, the backend decodes it and creates the readable goal context.

## Encoded Goal Files

Every goal writes these workspace files:

```text
.gptwork/goals/<goal_id>/goal.md
.gptwork/goals/<goal_id>/context.json
.gptwork/goals/<goal_id>/transcript.md
.gptwork/goals/<goal_id>/payload.json
.gptwork/goals/<goal_id>/payload.base64
.gptwork/goals/<goal_id>/result.md
```

The public `create_encoded_goal` response intentionally returns only concise paths (`dir`, `goal_md`, `result_md`). Internal/debug paths (`context.json`, `transcript.md`, `payload.json`, `payload.base64`) are available as `internal_files` and through `get_goal_context`. Attachment directories are only created and returned when a bundle is uploaded.

Important boundary: base64 is transport encoding only. The user sees the readable preview, the backend stores readable JSON/Markdown, and Codex executes readable instructions.

## Attachments

Instruction payloads use:

```text
JSON -> base64
```

File bundles use:

```text
zip -> base64
```

Available bundle tools:

- `upload_bundle_base64`
- `download_bundle_base64`
- existing `create_zip_archive` / `extract_zip_archive`

## Codex Worker Defaults

The backend worker runs Codex with:

```bash
codex exec --yolo --skip-git-repo-check < promptFile
```

Override with:

```bash
GPTWORK_CODEX_EXEC_ARGS="--yolo --skip-git-repo-check"
```

Codex execution timeout defaults to 300 seconds. Override with:

```bash
GPTWORK_CODEX_EXEC_TIMEOUT=300
```

Zip operations use Python. Override if needed:

```bash
GPTWORK_PYTHON=python3
```

## Expected Environment

```bash
GPTWORK_HOST=0.0.0.0
GPTWORK_PORT=8787
GPTWORK_REQUIRE_AUTH=true
GPTWORK_STATE_PATH=/home/a9017/mcp/gpt-codex-workspace/data/state.json
GPTWORK_TOKENS=dev-token,test
GPTWORK_WORKSPACE_ROOT=/home/a9017/mcp/workspace
GPTWORK_CODEX_HOME=/home/a9017
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_WORKER_INTERVAL_MS=5000
GPTWORK_CODEX_WORKER_CONCURRENCY=4
GPTWORK_CODEX_EXEC_ARGS="--yolo --skip-git-repo-check"
GPTWORK_SSH_SOCKS_PROXY=10.0.1.105:20177
```

SSH workspaces prefer key authentication. For hosts outside `10.0.0.0/8`, the default SOCKS proxy is `10.0.1.105:20177` unless a workspace-specific proxy is configured.

## Docs Kept

| File | Purpose |
|---|---|
| `README.md` | Project overview and quick start |
| `docs/current-status.md` | Current operating state |
| `docs/architecture.md` | System design |
| `docs/chatgpt-prompting-guide.md` | ChatGPT encoded goal behavior |
| `docs/chatgpt-app-manifest.json` | ChatGPT MCP connector metadata |
| `plugins/gpt-codex-workspace/skills/workspace-coordination/SKILL.md` | Codex workflow skill |

Removed/obsolete docs should not describe base64 as a way to hide unsafe intent.
