# gptwork-server.mjs — Current Responsibility Map

**File:** `backend/src/gptwork-server.mjs` (586 lines)
**Status:** P4 composition-root refactor mostly complete.
**Goal:** Keep public MCP tool names, schemas, and response shapes stable while moving implementation details into focused modules.

---

## Current Shape

`gptwork-server.mjs` now owns composition and startup glue:

- `createGptWorkServer()` assembles config, state, browser, GitHub, Bark, repo registry, worker state, tool registry, and HTTP/MCP handlers.
- `reconcileStaleTasks()` performs startup recovery for stalled tasks, restart markers, misplaced markers, and repo locks.
- `createTools()` wires tool groups and service callbacks together.
- `startCodexWorker()` delegates to `codex-worker.mjs`.
- HTTP listen/RPC dispatch remains in the returned server object.

No inline `tool(` registrations remain in `gptwork-server.mjs`; tool registration is delegated to `tool-groups/*.mjs`.

---

## Extracted Modules

| Responsibility | Module |
| --- | --- |
| HTTP request/SSE handling | `backend/src/http-handler.mjs` |
| MCP tool factory/registry | `backend/src/tool-registry.mjs`, `backend/src/mcp-tooling.mjs` |
| Runtime server context | `backend/src/server-context.mjs` |
| Tool registration groups | `backend/src/tool-groups/*.mjs` |
| Workspace file/shell/search/bundle operations | `backend/src/workspace-service.mjs` |
| Workspace lifecycle wrappers | `backend/src/workspace-lifecycle.mjs` |
| Goal/task lifecycle wrappers | `backend/src/goal-task-lifecycle.mjs` |
| Task state helpers | `backend/src/task-lifecycle.mjs` |
| Goal normalization helpers | `backend/src/goal-lifecycle.mjs` |
| Goal workspace file paths/rendering | `backend/src/goal-files.mjs` |
| General Codex task processing | `backend/src/task-general-processor.mjs` |
| Codex worker dispatch loop | `backend/src/codex-worker.mjs` |
| Codex run setup/execution/final writeback | `backend/src/task-run-setup.mjs`, `backend/src/task-codex-execution.mjs`, `backend/src/task-final-writeback.mjs` |
| Task result status decisions | `backend/src/task-result-status.mjs` |
| Worker queue counts | `backend/src/worker-queue-counts.mjs` |
| Notifications | `backend/src/notification-service.mjs`, `backend/src/bark-notifier.mjs` |
| Diagnostics/runtime status/context health | `backend/src/diagnostics-service.mjs` |
| Safe restart markers | `backend/src/safe-restart.mjs`, `backend/src/restart-tools.mjs` |
| Repo locks | `backend/src/repo-lock.mjs` |
| Git remote operations | `backend/src/git-remote-tools.mjs` |

---

## P0/P1 Fixes Reflected

- Safe restart expected-commit handling has regression coverage for short SHA normalization, similar-prefix full SHA mismatch, and stale `result.json` commit rejection in favor of repo `HEAD`.
- `StateStore.mutate()` serializes updater plus save, and `StateStore` exposes id lookup helpers for tasks, goals, and workspaces.
- `workspaceSearch()` supports default excludes, `max_file_bytes`, binary sniffing, and `max_total_bytes`; hosted and SSH search paths both receive size/exclude controls.
- `download_bundle_base64` keeps legacy `max_bytes` behavior and adds `max_bundle_bytes` with explicit `{ ok: false, error: "too_large", too_large: true }` response.
- Git remote handlers use async process execution with response-shape and error-path regression tests.

---

## Failure History Notes

- P4.3e previously attempted a one-shot `processGeneralTask` move, timed out after 2400s, and left syntax-invalid dirty code.
- Current refactor avoided that path by first extracting stable lifecycle modules, then moving the reduced general-task processor into `task-general-processor.mjs` with focused regression tests.
- Timeout recovery rule remains: inspect diff, run syntax import/tests, and do not continue from broken dirty files.

---

## Remaining Candidates

- `reconcileStaleTasks()` is the largest remaining server-local implementation block and can be extracted next into a startup reconciliation module.
- ChatGPT request CRUD still remains in server-local callbacks through its tool group wiring.
- Runtime-source changes still require `cd backend && npm test` plus safe restart verification before handoff.
