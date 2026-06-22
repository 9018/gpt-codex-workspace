# GPTWork Card / Queue Surface Diagnosis

Date: 2026-06-22

## Baseline

```text
HEAD: ad6d0b8c5e89b5446e204b14d21f906267b321f0
running_commit before deploy: ad6d0b8c5e89b5446e204b14d21f906267b321f0
worktree before fix: dirty only because the goal package was untracked
active_tasks: one chatgpt queued task; stale target task_3921b1af-8e33-47c4-a577-ca5ac5abb3ec is waiting_for_review
repo_locks: no active repo locks; one stale lock owned by the stale target task
worker_queue: assigned=0 queued=0 running=0 waiting_for_lock=0 waiting_for_review=1 completed=162 failed=0
decision: proceed; stale run is not active and is not modifying the repo
```

The live HTTP MCP endpoint before this change was still serving the old process. It exposed all six queue tools, but `worker_status` had no card descriptor metadata and the v2 HTML did not include the visible no-payload fallback.

## Source-Level Findings

- `toolList()` copies `metadata.outputTemplate` to `_meta["openai/outputTemplate"]` and `metadata.resourceUri` to `_meta.ui.resourceUri`.
- Queue tools were registered and visible in source standard mode.
- `worker_status` lacked `outputTemplate` and `resourceUri`, so it could not trigger the v2 card.
- `read_handoff` was listed as a card-domain tool but lacked the same descriptor metadata.
- `widget-card-v2.html` rendered `{}` when no payload was available, but did not render the required explicit fallback text or diagnostics.

## MCP Protocol Evidence After Source Fix

Local in-process MCP smoke report:

```text
protocolVersion: 2025-03-26
serverInfo: GPTWork MCP 0.1.0
tool count: 64
queue tools present: enqueue_goal, list_goal_queue, get_goal_queue, start_next_queued_goal, update_goal_queue_item, cancel_goal_queue_item
worker_status _meta: openai/outputTemplate=ui://widget/gptwork-card-v2.html, ui.resourceUri=ui://widget/gptwork-card-v2.html
runtime_status _meta: openai/outputTemplate=ui://widget/gptwork-card-v2.html, ui.resourceUri=ui://widget/gptwork-card-v2.html
gptwork_self_test _meta: openai/outputTemplate=ui://widget/gptwork-card-v2.html, ui.resourceUri=ui://widget/gptwork-card-v2.html
v2 resource mimeType: text/html;profile=mcp-app
v2 HTML byte length: 11514
```

Mode exposure report:

```text
minimal: no queue tools
standard: all six queue tools
operator: list_goal_queue, get_goal_queue
codex: all six queue tools
full: all six queue tools
```

## Root-Cause Hypotheses

1. Blank gray card: server-side widget HTML did not guarantee a visible fallback when `window.openai` payload injection was absent or delayed. The renderer now checks `toolOutput`, `structuredContent`, `output`, `toolResult`, `messages`, message events, and renders an explicit fallback/error panel instead of leaving a blank or skeleton-like body.
2. Missing queue tools: source had already been fixed to register queue tools. Current evidence shows all six are present in source and live standard mode. If ChatGPT still hides them after deploy/reconnect, the remaining cause is connector/client cache or bridge refresh, not missing server registration.
3. `worker_status` no card rendering: confirmed server bug. The descriptor lacked both `_meta["openai/outputTemplate"]` and `_meta.ui.resourceUri`. Added both metadata fields.

## Fix Plan Implemented

- Add v2 descriptor metadata to `worker_status`.
- Add v2 descriptor metadata to `read_handoff` to match the v2 widget domain.
- Make `widget-card-v2.html` render a visible fallback and visible renderer errors.
- Add regression tests for required card descriptors, no-payload fallback, self-contained HTML, and executed inline render paths for `structuredContent` and `toolOutput`.

## Live Endpoint Before Deploy

The running process at `http://127.0.0.1:8787/mcp/dev-token` still showed old behavior before commit/restart:

```text
live queue tools: all six present
live worker_status _meta: null
live v2 fallback string present: false
live running_commit: ad6d0b8c5e89b5446e204b14d21f906267b321f0
```

This proves deployment/restart is required after commit.
