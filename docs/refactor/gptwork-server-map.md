# gptwork-server.mjs — Pre-Refactor Responsibility Map

**File:** `backend/src/gptwork-server.mjs` (3419 lines)
**Status:** Pre-refactor baseline — all responsibilities currently live in one file.
**Goal:** Decompose into focused modules without changing behavior (P2).

---

## Current Responsibilities

### 1. HTTP / MCP Server Composition Root (lines ~420–460, ~506–510)

- `handleHttp()` — HTTP request dispatch, CORS, SSE streaming, health check routing.
- `handleRpc()` — JSON-RPC method dispatch (initialize, tools/list, tools/call).
- `listen()` — HTTP server lifecycle with port-conflict retry.
- `createGptWorkServer()` — Assembles all dependencies (StateStore, BrowserRegistry, GithubSync, RepoRegistry, BarkNotifier, config, env), starts the server, returns the service object.

### 2. Workspace & File Tools (lines ~1145–1160, ~3060–3210)

- `workspaceListDir()`, `workspaceStat()`, `workspaceReadText()`, `workspaceDownloadBase64()`
- `workspaceWriteText()`, `workspaceUploadBase64()`, `workspaceUploadFromUrl()`
- `workspaceUploadBundleBase64()`, `workspaceDownloadBundleBase64()`
- `workspaceMkdir()`, `workspaceDelete()`, `workspaceMove()`, `workspaceCopy()`
- `workspaceSearch()`, `workspaceSha256()`, `workspaceShellExec()`
- `workspaceShellZip()` / `runZipCommand()`
- `resolvePath()`
- ~15 workspace-related tool registrations

### 3. Project & Repository Tools (lines ~936–960, ~1180–1250)

- `list_projects`, `get_project`, `list_workspaces`, `get_workspace_info`, `set_active_workspace`
- `create_workspace`, `update_workspace`, `delete_workspace`, `test_workspace_connection`
- `register_repository`, `list_repositories`, `get_repository_status`, `resolve_canonical_repository`
- `detect_stale_clones`
- Helper functions: `createWorkspace()`, `updateWorkspace()`, `deleteWorkspace()`, `testWorkspaceConnection()`, `setDefaultWorkspace()`

### 4. Task & Goal Lifecycle (lines ~970–1010, ~1570–2390)

- `create_task`, `list_tasks`, `get_task`, `update_task_status`, `append_task_log`, `attach_task_artifact`
- `assign_task_to_codex`, `complete_task`, `request_human_review`
- `create_goal`, `create_encoded_goal`, `list_goals`, `get_goal_context`, `append_goal_message`
- `list_codex_sessions_metadata`, `create_codex_session_inventory_task`
- Helper functions:
  - Task: `createTask()`, `findTask()`, `updateTask()`, `ensureTaskGoal()`
  - Goal: `ensureGoalState()`, `createGoal()`, `createEncodedGoal()`, `listGoals()`, `getGoalContext()`, `appendGoalMessage()`, `findGoalInState()`
  - Goal files: `writeGoalWorkspaceFiles()`, `writeWorkspaceTextInternal()`, `goalWorkspaceFiles()`, `publicGoalWorkspaceFiles()`, `internalGoalWorkspaceFiles()`, `hasGoalBundles()`
  - Rendering: `renderGoalMarkdown()`, `renderTranscriptMarkdown()`, `codexInstruction()`, `buildGoalTask()`, `titleFromGoal()`, `normalizeGoalMessages()`, `normalizeGoalMessage()`, `normalizeGoalMemories()`, `normalizeGoalMemory()`, `normalizeCreatedTaskMode()`, `normalizeAssignedTaskMode()`
  - Task execution: `waitForTaskExecution()`, `taskExecutionSnapshot()`, `isTaskTerminal()`, `updateGoalStatus()`

### 5. Codex Worker Execution (lines ~458–508, ~2397–2520)

- `startCodexWorker()` — Event-loop-based worker that polls for assigned tasks.
- `runAssignedCodexTasks()` — Inventory-task vs. general-task dispatch.
- `processGeneralTask()` — Core Codex execution: context building, Codex subprocess launch, result parsing, result file writing, status updates.
- `createCodexSessionInventoryTask()`, `completeCodexSessionInventoryTask()`
- `isCodexSessionInventoryTask()`, `isCodexSessionInventoryTaskKind()`
- `emitTaskProgress()`, `extractTaskLimit()`
- `mapConcurrent()`

### 6. Diagnostic & Status Tools (lines ~928–930, ~1050–1080, ~1280–1500)

- `health_check` — Server health endpoint.
- `runtime_status` — Process, git, config, env, bark, restart marker, repo locks.
- `runtime_status` helper functions: `resolveRepoDir()`, `determineBarkConfigSource()`
- `project_context_status` / `context_status` — `queryContextStatus()` (~lines 520–840): context source health, project files, warnings, task info.
- `context_prepare` — `contextPrepareHandler()`: auto-fix for missing `.gptwork/` dir, project.md, project.env.
- `gptwork_doctor` — Comprehensive user-facing diagnostic summary.
- `notification_status`, `test_bark_notification`
- `list_recent_activity`
- Various helper functions for diagnostics.

### 7. ChatGPT Request Coordination (lines ~1116–1145)

- `create_chatgpt_request`, `list_chatgpt_requests`, `get_chatgpt_request`, `answer_chatgpt_request`
- `createChatGptRequest()`, `findChatGptRequest()`, `updateChatGptRequest()`

### 8. Browser Tools (lines ~1258–1310)

- `browser_new_session` through `browser_evaluate` (15 tools)
- Lightweight HTTP browser proxy backed by `BrowserRegistry`

### 9. Git Remote Tools (lines ~1320–1440)

- `git_remote_resolve_repo`, `git_remote_fetch`, `git_remote_status`, `git_remote_list_files`
- `git_remote_read_file`, `git_remote_changed_files`, `git_remote_diff`, `git_remote_show_commit`
- `git_remote_compare_local`
- Delegates to `git-remote-tools.mjs` handlers.

### 10. Safe Restart & Repo Lock Management

- Integrated into tool handlers (`schedule_service_restart`, `list_pending_restarts`).
- Delegates to `safe-restart.mjs` and `repo-lock.mjs`.

### 11. GitHub Sync Tools (lines ~1165–1195)

- `sync_to_github`, `sync_from_github`, `github_status`, `sync_github_comments`
- Delegates to `github-adapter.mjs`.

### 12. Auth / Token Context

- Integrated into tool handler wrappers.
- Delegates to `auth-context.mjs`.

### 13. Config & State Bootstrapping

- `config` assembly with source tracking (options > process.env > runtime.env > defaults).
- `StateStore` initialization with old-state migration.
- `envLoadResult` tracking for diagnostics.

---

## Tool Registry Snapshot

The `createTools()` function registers ~90+ MCP tools in a flat dictionary. Each tool is `(description, inputSchema, handler)`. The handler closure captures `store`, `config`, `browser`, `github`, `bark`, `registry`, `envLoadResult`, `sources`.

Key groups by count:
- **Workspace file/shell tools**: ~15
- **Browser tools**: ~15
- **Git remote tools**: ~9
- **Task/goal lifecycle tools**: ~20
- **Project/workspace/registry tools**: ~12
- **Diagnostic/status tools**: ~8
- **ChatGPT request tools**: ~4
- **GitHub sync tools**: ~4
- **Health/diagnostic helpers**: ~4
- **Other (auth, config)**: the rest

---

## Proposed Future Modules (P2)

### Module Structure

```
backend/src/
├── gptwork-server.mjs       → slimmed: composition root + tool registry wiring
├── server/
│   └── http-handler.mjs     → HTTP/SSE/JSON-RPC dispatch (handleHttp, handleRpc, listen)
├── tools/
│   ├── project-tools.mjs    → list_projects, get_project, list_workspaces, workspace CRUD
│   ├── workspace-tools.mjs  → list_dir, read/write file, mkdir, delete, move, copy, shell_exec, zip
│   ├── goal-tools.mjs       → create_goal, create_encoded_goal, list_goals, get_goal_context, append_goal_message
│   ├── task-tools.mjs       → create_task, list_tasks, get_task, update_task_status, assign_task, complete_task
│   ├── worker-tools.mjs     → run_assigned_codex_tasks, preview_codex_context, codex-session-inventory tools
│   ├── diagnostic-tools.mjs → health_check, runtime_status, project_context_status, gptwork_doctor, etc.
│   └── chatgpt-tools.mjs    → create/list/get/answer_chatgpt_request
├── worker/
│   └── codex-worker.mjs     → runAssignedCodexTasks, processGeneralTask, startCodexWorker, session-inventory
├── goal/
│   └── goal-files.mjs       → renderGoalMarkdown, writeGoalWorkspaceFiles, transcript rendering
└── task/
    └── task-lifecycle.mjs   → createTask, ensureTaskGoal, findTask, updateTask, taskPayloadFromTask
```

### Explicit Rule for P2

> First move code without changing behavior. Extract functions, imports, and tool handler references into their new module files, then re-export / re-import from the slimmed `gptwork-server.mjs`. Do not refactor signatures, rename functions, change error handling, add logging, or alter tool names/schemas during the extraction phase. Pure structural decomposition only.

### Recommended Extraction Order

1. **goal/goal-files.mjs** — goal markdown rendering and goal workspace file writing (`renderGoalMarkdown`, `renderTranscriptMarkdown`, `writeGoalWorkspaceFiles`, `codexInstruction`, `buildGoalTask`, `titleFromGoal`, `goalWorkspaceFiles`, etc.). Lowest risk — pure rendering functions with no side effects beyond writing files.

2. **worker/codex-worker.mjs** — Codex execution glue (`runAssignedCodexTasks`, `processGeneralTask`, `startCodexWorker`, `createCodexSessionInventoryTask`, `isCodexSessionInventoryTask`). Self-contained async orchestration with clear boundaries.

3. **tools/workspace-tools.mjs** — workspace file and shell tool handlers + helper functions. Large surface area but well-isolated; each handler delegates to its corresponding helper, making extraction straightforward.

4. **task/task-lifecycle.mjs** and **tools/goal-tools.mjs** — task/goal lifecycle CRUD. These are tightly coupled to `store` and `config` and share helper functions, so extract them together.

5. **server/http-handler.mjs** and tool registry composition in `gptwork-server.mjs` — the final step. Once all handler functions are in their own modules, slim `gptwork-server.mjs` to import them and wire up the tool registry in `createTools()`.

---

## Dependencies & Coupling Notes

- Most handler functions depend on `store` (StateStore), `config` (RuntimeConfig), and `context` (auth context).
- `processGeneralTask()` depends on `github` (GithubSync) for task result posting.
- `createTools()` captures all dependencies in closure and builds the tool dictionary. It is the single point of tool registration.
- Browser tools delegate to `browser` (BrowserRegistry).
- Git remote tools delegate to `git-remote-tools.mjs` handlers.
- GitHub sync tools delegate to `github-adapter.mjs`.
- Auth/context delegation comes from `auth-context.mjs`.
- Safe restart and repo lock delegation comes from `safe-restart.mjs` and `repo-lock.mjs`.
- Config bootstrapping and source tracking are shared across all tools.

This means the extraction can proceed module-by-module without needing to refactor the dependency injection pattern. Each extracted module simply receives `store`, `config`, and other dependencies as function arguments, matching the current calling convention.

---

## Current P4 Snapshot

**Current commit:** `ba29e00d112fd11433aa3b3caf4982b3911ddd86`
**File:** `backend/src/gptwork-server.mjs` (1278 lines)

### Current Reality

- `gptwork-server.mjs` has no inline `: tool(` MCP registrations.
- HTTP/SSE/JSON-RPC dispatch is extracted to `http-handler.mjs`.
- Codex worker dispatch helpers are extracted to `codex-worker.mjs`.
- Bark notification helpers are extracted to `notification-service.mjs`.
- `processGeneralTask()` still remains in `gptwork-server.mjs`, with result-status, prompt/run setup, Codex execution, and final writeback helpers extracted.
- State persistence now caps `activities`, exposes `StateStore.mutate()`, and batches final task/goal writeback where available.
- Worker queue counts are delegated to a one-pass counter module.
- Workspace search now skips common generated/vendor directories and caps per-file content reads; bundle download now enforces a result-size cap.
- Git remote inspection tools now use an async bounded `spawn("git", ...)` runner instead of synchronous git subprocess calls.

### P4.3 Extraction Results

| Area | Current module | Notes |
| --- | --- | --- |
| Tool registration groups | `tool-groups/*.mjs` | P4.2 removed inline tool registrations from `gptwork-server.mjs`. |
| HTTP/MCP transport | `http-handler.mjs` | `gptwork-server.mjs` wires the handler as composition root. |
| Worker dispatch loop | `codex-worker.mjs` | `startCodexWorker()`, `runAssignedCodexTasks()`, and `mapConcurrent()` are delegated out. |
| Notifications | `notification-service.mjs` | Terminal and created-task Bark notification helpers are delegated out. |
| Result-status derivation | `task-result-status.mjs` | `processGeneralTask()` delegates status mapping plus autonomy/runtime guards. |
| Prompt/run setup | `task-run-setup.mjs` | Prompt file creation, run metadata init, and first heartbeat are delegated out. |
| Codex execution | `task-codex-execution.mjs` | Codex command execution, run log persistence, parsing heartbeat, and parsed summary selection are delegated out. |
| Final writeback | `task-final-writeback.mjs` | Final heartbeat, task/goal state writes, repo lock release, result markdown, and GitHub sync are delegated out. |
| General task execution | `gptwork-server.mjs` | `processGeneralTask()` remains as a thinner orchestration wrapper. |
| State persistence | `state-store.mjs` | Activities are capped before save and `mutate()` batches load/update/save. |
| Worker queue status | `worker-queue-counts.mjs` | Runtime queue counters are computed in one pass. |
| Workspace read limits | `workspace-service.mjs` | Search has default excluded dirs and max file bytes; bundle downloads reject oversized ZIP results. |
| Git remote inspection | `git-remote-tools.mjs` | Git commands run through async bounded child processes. |

### Recommended Next Decomposition

Do not extract all of `processGeneralTask()` in one task. Split it into focused helpers:

1. Move the thin `processGeneralTask()` wrapper only if further decomposition still provides value.
2. Continue with additional focused performance work only after committing and restart-verifying this runtime batch.

---

## Phase 2 & 3 — Extraction Results (Post-Refactor)

**Baseline commit:** `920fffca4792bd29a1eb453324b1bc757e87eda3`
**File:** `backend/src/gptwork-server.mjs` (2596 lines, down from 3419)
**Total modules in `backend/src/`:** 33 `.mjs` files (including `tool-groups/`)

### Summary

P2 and P3 extraction removed ~823 lines from `gptwork-server.mjs`, introducing 13 new
modules and 2 `tool-groups/` registration modules. The file remains the composition root
and tool registry, but helper functions and pure selectors now live in focused modules.

---

### Extracted Modules — P2 (Pure Extraction)

#### 1. `goal-files.mjs` (200 lines) — P2.1

Goal markdown rendering and goal workspace file writing. Extracted the lowest-risk,
deterministic rendering functions with no side effects beyond file I/O.

- `goalWorkspaceFiles()`, `publicGoalWorkspaceFiles()`, `internalGoalWorkspaceFiles()`
- `hasGoalBundles()`
- `renderGoalMarkdown()`, `renderTranscriptMarkdown()`
- `codexInstruction()`, `safeBundleName()`

#### 2. `task-status.mjs` (57 lines) — P2.2

Pure task-status selector predicates. Extracted first to unblock lifecycle module extraction.

- `isTaskTerminal()`, `isCodexSessionInventoryTask()`, `isCodexSessionInventoryTaskKind()`
- `extractTaskLimit()`

#### 3. `task-lifecycle.mjs` (165 lines) — P2.3

Task and goal lifecycle CRUD helpers. Centralizes state lookups and lightweight writes.

- `ensureGoalState()`, `findGoalInState()`
- `taskPayloadFromTask()`, `emitTaskProgress()`
- `normalizeLegacyModes()`, `findTask()`, `updateTask()`, `updateGoalStatus()`
- `setTerminalNotifier()`

#### 4. `goal-lifecycle.mjs` (111 lines) — P2.4

Goal message/memory normalization helpers. Pure functions for reshaping conversation data.

- `titleFromGoal()`
- `normalizeGoalMessage()`, `normalizeGoalMessages()`
- `normalizeGoalMemory()`, `normalizeGoalMemories()`

#### 5. `workspace-service.mjs` (445 lines) — P2.5

Workspace file operations, shell execution, zip handling. The largest extracted module
covers ~15 tool handler implementations plus their helper functions.

- File ops: `resolvePath()`, `workspaceListDir()`, `workspaceStat()`,
  `workspaceReadText()`, `workspaceDownloadBase64()`, `workspaceWriteText()`,
  `workspaceUploadBase64()`, `workspaceUploadFromUrl()`,
  `workspaceUploadBundleBase64()`, `workspaceDownloadBundleBase64()`,
  `workspaceMkdir()`, `workspaceDelete()`, `workspaceMove()`, `workspaceCopy()`
- Search: `workspaceSearch()`, `workspaceSha256()`
- Shell: `workspaceShellExec()`, `runLocalShell()`
- Zip: `workspaceShellZip()`, `runZipCommand()`
- Internal: `writeWorkspaceTextInternal()`

#### 6. `diagnostics-service.mjs` (255 lines) — P2.6

Diagnostics aggregation helpers. Collects runtime git info, restart marker status,
bark config detection, and the `queryContextStatus()` orchestration.

- `resolveRepoDir()`, `determineBarkConfigSource()`
- `collectRuntimeGitInfo()`, `collectRestartMarkerStatus()`
- `queryContextStatus()`

#### 7. `codex-worker-state.mjs` (78 lines) — P2.7

Worker state tracking lifecycle. Manages the in-memory `workerState` object used by
the event-loop worker and exposed via `runtime_status`.

- `createWorkerState()`, `markWorkerStarted()`, `markWorkerTickStarted()`
- `recordWorkerTickSuccess()`, `recordWorkerTickError()`, `markWorkerTickFinished()`
- `workerStatusSnapshot()`

#### 8. `restart-tools.mjs` (30 lines) — P2.8

Thin standalone dispatch for restart tool handlers. Bridges the tool-group registration
layer to the `safe-restart.mjs` utilities.

- `handleScheduleServiceRestart()`, `handleListPendingRestarts()`

#### 9. `tool-groups/restart-tools-group.mjs` (16 lines) — P2.9

Restart tool group registration. Demonstrates the `<name>-tools-group.mjs` pattern:
a function returning a tool dictionary with `{ description, inputSchema, handler }` triples.

- `createRestartToolsGroup()`
  - Registers `schedule_service_restart`, `list_pending_restarts`

#### 10. `tool-groups/repo-lock-tools-group.mjs` (24 lines) — P2.10

Repo lock tool group registration. Same pattern as above.

- `createRepoLockToolsGroup()`
  - Registers `list_repo_locks`, `repo_lock_status`

---

### Extracted / Introduced Modules — P3 (Abstraction & Contract)

#### 11. `server-context.mjs` (55 lines) — P3.1

Server context helper. Introduced as a new module to centralize server-level
configuration merging and context creation, rather than extracting existing code.

- `OPTION_SOURCE_MAP`
- `applyOptionSourceOverrides()`
- `createServerContext()`

#### 12. `tool-registry.mjs` (3 lines) — P3.2

Tool factory helper. A minimal `createTool()` function that structures tool
definitions as `{ description, inputSchema, handler }` triples. Used across
`createTools()` and all tool-group modules.

#### 13. `codex-finalizer-contract.mjs` (336 lines) — P3.3

Finalizer result shape contract and validation. Consolidates status
constants, result factory functions, and runtime-change detection that
was duplicated between `codex-result-parser.mjs` and `gptwork-server.mjs`.

- `STATUS_COMPLETED`, `STATUS_FAILED`, `STATUS_TIMED_OUT`, `VALID_STATUSES`
- `KIND_EXECUTED`, `KIND_FAILED`, `KIND_TIMEOUT`
- `RESULT_FIELDS`, `RUNTIME_SRC_PATTERNS`
- `isValidStatus()`, `isNoopResult()`
- `createSuccessResult()`, `createNoopResult()`, `createFailedResult()`, `createTimeoutResult()`
- `validateFinalizerResult()`, `detectRuntimeCodeChanges()`, `checkResultForRuntimeChanges()`

---

### What Still Remains in `gptwork-server.mjs`

After P2/P3, the file retains the **composition root** and **tool registry wiring**
plus several **not-yet-extracted** functional areas.

| Section | Lines | Functions | Description |
|---|---|---|---|
| **Composition root** | 79–597 | `createGptWorkServer()` | Dependency assembly (StateStore, BrowserRegistry, GithubSync, RepoRegistry, BarkNotifier, config, env) and server boot (listen, HTTP/JSON-RPC dispatch). |
| **Tool registry builder** | 598–1447 | `createTools()` | Registrations for ~90 MCP tools in a flat dictionary. Each tool is `(description, inputSchema, handler)`. Uses `createTool` from `tool-registry.mjs`. |
| **HTTP/SSE/JSON-RPC dispatch** | 1448–1475 | `handleHttp()` | Raw HTTP request dispatch, CORS, SSE streaming, health check routing. `handleRpc()` inline. |
| **Workspace CRUD** | 1476–1583 | `createWorkspace()`, `updateWorkspace()`, `deleteWorkspace()`, `testWorkspaceConnection()`, `setDefaultWorkspace()` | Project/workspace registry lifecycle (not to be confused with workspace file operations in `workspace-service.mjs`). |
| **Task lifecycle** | 1584–1908 | `createTask()`, `ensureTaskGoal()`, `waitForTaskExecution()`, `taskExecutionSnapshot()` | Core task CRUD and execution tracking. |
| **Goal lifecycle** | 1616–1983 | `createGoal()`, `createEncodedGoal()`, `listGoals()`, `getGoalContext()`, `appendGoalMessage()`, `writeGoalWorkspaceFiles()`, `buildGoalTask()` | Goal CRUD, encoded goal creation, workspace file writing, and context assembly. |
| **Mode normalization** | 1984–2011 | `normalizeCreatedTaskMode()`, `normalizeAssignedTaskMode()` | Mode validation/coercion for task creation and assignment. |
| **Session inventory** | 2012–2079 | `listCodexSessionsMetadata()`, `validateDateSegment()`, `createCodexSessionInventoryTask()` | Codex session inventory task creation and date-segment validation. |
| **Codex worker execution** | 2080–2150 | `runAssignedCodexTasks()`, `mapConcurrent()`, `completeCodexSessionInventoryTask()` | Event-loop worker polling, concurrency control, and inventory completion. |
| **General task processing** | 2152–2431 | `processGeneralTask()` | Core Codex execution: context building, subprocess launch, result parsing, result file writing, status updates. |
| **Task notifications** | 2432–2537 | `notifyTerminalTaskIfNeeded()`, `notifyCreatedTaskIfNeeded()` | Terminal/created-task Bark notifications. |
| **ChatGPT request tools** | 2538–2596 | `createChatGptRequest()`, `findChatGptRequest()`, `updateChatGptRequest()` | ChatGPT request CRUD. |
| **Misc** | — | `collectWorkerQueueCounts()`, `decodeTaskDescriptionEnvelope()`, `decodeBase64Json()`, `PROCESS_STARTED_AT`, `workerState` | Helper functions and module-level state. |

### Updated Tool Registry Snapshot

The `createTools()` function (line 598) still registers ~90 MCP tools, but tool
definitions are now structured via `createTool()` and:

- **Restart tools** are delegated to `createRestartToolsGroup()` (`tool-groups/restart-tools-group.mjs`)
- **Repo-lock tools** are delegated to `createRepoLockToolsGroup()` (`tool-groups/repo-lock-tools-group.mjs`)
- All other tools remain inline in `createTools()`

### Updated Module Structure

```
backend/src/
├── gptwork-server.mjs           → composition root + tool registry wiring (2596 lines)
│   (still contains: goal/task lifecycle, worker execution, ChatGPT requests,
│   workspace CRUD, mode normalization, session inventory)
├── server-context.mjs            → P3.1: createServerContext, OPTION_SOURCE_MAP (55 lines)
├── tool-registry.mjs             → P3.2: createTool factory (3 lines)
├── codex-finalizer-contract.mjs  → P3.3: finalizer result shape & validation (336 lines)
├── workspace-service.mjs         → P2.5: workspace file ops, shell, zip (445 lines)
├── diagnostics-service.mjs       → P2.6: runtime git info, restart markers, context status (255 lines)
├── task-lifecycle.mjs            → P2.3: task/goal state helpers (165 lines)
├── goal-lifecycle.mjs            → P2.4: goal message normalization (111 lines)
├── goal-files.mjs                → P2.1: goal rendering & workspace file writing (200 lines)
├── task-status.mjs               → P2.2: pure task predicates (57 lines)
├── codex-worker-state.mjs        → P2.7: worker state lifecycle (78 lines)
├── restart-tools.mjs             → P2.8: restart handler dispatch (30 lines)
├── tool-groups/
│   ├── restart-tools-group.mjs   → P2.9: restart tool registration (16 lines)
│   └── repo-lock-tools-group.mjs → P2.10: repo-lock tool registration (24 lines)
├── codex-context-builder.mjs     → (pre-existing) context building
├── codex-prompt-builder.mjs      → (pre-existing) prompt construction
├── codex-result-parser.mjs       → (pre-existing) result parsing
├── codex-run-metadata.mjs        → (pre-existing) run metadata
├── safe-restart.mjs              → (pre-existing) restart marker utilities
├── repo-lock.mjs                 → (pre-existing) repo locking primitives
├── repo-registry.mjs             → (pre-existing) repository state
├── git-remote-tools.mjs          → (pre-existing) git remote handlers
├── github-adapter.mjs            → (pre-existing) GitHub sync
├── auth-context.mjs              → (pre-existing) auth token context
├── bark-notifier.mjs             → (pre-existing) Bark notification
├── browser-http.mjs              → (pre-existing) Browser HTTP proxy
├── ssh-adapter.mjs               → (pre-existing) SSH command runner
├── runtime-config.mjs            → (pre-existing) config builder
├── runtime-env.mjs               → (pre-existing) env loader
├── state-store.mjs               → (pre-existing) JsonlStore persistence
├── mcp-tooling.mjs               → (pre-existing) MCP tool helpers
├── path-utils.mjs                → (pre-existing) path utilities
├── cli.mjs                       → (pre-existing) CLI entry point
└── rest-tools.mjs                → (pre-existing, renamed) placeholder
```

### Future Candidate Extractions (P4+)

1. **`worker/codex-worker.mjs`** — event-loop worker: `runAssignedCodexTasks()`,
   `processGeneralTask()`, `completeCodexSessionInventoryTask()`, `mapConcurrent()`.
   Self-contained async orchestration with clear boundaries.

2. **`tools/project-tools.mjs`** — workspace CRUD: `createWorkspace()`,
   `updateWorkspace()`, `deleteWorkspace()`, `testWorkspaceConnection()`.

3. **`tools/goal-tools.mjs`** — goal CRUD: `createGoal()`, `createEncodedGoal()`,
   `listGoals()`, `getGoalContext()`, `appendGoalMessage()`, `writeGoalWorkspaceFiles()`.

4. **`tools/task-tools.mjs`** — task CRUD: `createTask()`, `ensureTaskGoal()`,
   `waitForTaskExecution()`, `taskExecutionSnapshot()`.

5. **`tools/chatgpt-tools.mjs`** — ChatGPT request CRUD.

6. **`server/http-handler.mjs`** — `handleHttp()`, `handleRpc()`, `listen()`.
