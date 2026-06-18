# gpt-codex-workspace

## Purpose

ChatGPT <-> Codex MCP coordination backend. Bridges user requests from ChatGPT into structured Codex execution goals, manages workspace files, task lifecycle, and result collection.

## Main Runtime Entrypoints

- `backend/src/cli.mjs` — CLI entrypoint; starts the HTTP/MCP server and optionally the Codex worker.
- `backend/src/gptwork-server.mjs` — Core server logic: HTTP handler, tool registry, workspace/shell tools, goal/task lifecycle, worker execution loop, safe restart, diagnostics.
- `plugins/gpt-codex-workspace/mcp/server.mjs` — ChatGPT-side MCP proxy plugin; translates ChatGPT JSON-RPC messages to the gptwork MCP server.

## Core Workflow

```
User request -> ChatGPT preview/payload -> create_encoded_goal ->
.gptwork/goals/<goal_id>/ files -> task -> Codex worker ->
result.json/result.md -> append_goal_message
```

## Common Commands

```bash
cd backend && npm test
cd backend && npm run test:clean
cd backend && node src/cli.mjs
```

## Runtime Notes

- Default port: **8787**
- Default hosted workspace root: `/home/a9017/mcp/workspace`
- Default state path: `/home/a9017/mcp/workspace/.gptwork/state.json`
- Codex worker is enabled by `GPTWORK_CODEX_WORKER=true`
- Project-level `.gptwork/project.md` and `.gptwork/project.env` are Codex context inputs, **not** service-level runtime env replacements.

## Execution Rules for Codex

1. Run `npm test` after backend changes.
2. Preserve `result.json` compatibility.
3. Preserve safe restart protocol for service restart work.
4. Prefer smallest reversible goal-aligned changes.
5. Do not ask ChatGPT about code navigation, implementation choices, routine test failures, or local verification strategy.

## P1.0 Default Subagent Policy

- Default `subagent_policy.mode` is **optional** (non-blocking) since P1.0.
- Goals created without explicit `subagent_policy` now use `mode: "optional"` and `require_review_before_completion: false`.
- This prevents routine Codex tasks from entering `waiting_for_review` solely because no formal subagent report was emitted.
- Explicit `subagent_policy.mode: "required"` still enforces strict subagent validation via `validateAutonomyResult`.
- Default `require_test_or_verification: true` is preserved.

## P1 Worker Diagnostics

- `worker_status` tool: Returns Codex worker process state (enabled, running, timing, last error) and queue counts (assigned, queued, running, waiting_for_lock, waiting_for_review, completed, failed).
- `runtime_status.worker`: Compact worker summary added to runtime diagnostics.
- `gptwork_doctor.worker` + suggestions: Worker diagnostics and actionable suggestions in the comprehensive doctor tool.
- Worker state tracked in module-level `workerState` object in `gptwork-server.mjs`; updated by `startCodexWorker` on tick lifecycle.
- Queue counts via `collectWorkerQueueCounts(store)` reading codex-assigned tasks from state store.
