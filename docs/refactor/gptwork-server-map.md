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
