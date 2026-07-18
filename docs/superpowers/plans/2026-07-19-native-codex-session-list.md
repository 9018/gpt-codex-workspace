# Native Codex Session List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production MCP tool that returns a Codex Resume-style native session list enriched with title, cwd, message count, last assistant reply, lifecycle status, and direct attach compatibility.

**Architecture:** Extend the existing session inventory tool group with a bounded JSONL summarizer and a `codex_native_sessions_list` MCP handler. Reuse the current native-session path validation and TUI manager state, keeping list aggregation read-only and isolating malformed session files per item.

**Tech Stack:** Node.js ESM, built-in `node:test`, filesystem APIs, existing Codex TUI session manager and MCP tool registry.

## Global Constraints

- Default to the configured `CODEX_HOME/sessions` root, including the existing legacy fallback.
- Do not return raw transcript content beyond the bounded title and final assistant preview fields.
- Filter `__gptwork_test_invalid_arg__` sessions unless `include_test_sessions=true`.
- Status must be evidence-based: `running`, `finished`, or `idle`.
- Returned `session_id` must work directly with `codex_native_session_attach`.
- One malformed JSONL file must not fail the complete list operation.
- Preserve existing native-session read, attach, status, send, and detach behavior.

---

### Task 1: Native session summary parser

**Files:**
- Modify: `backend/src/tool-groups/session-inventory-tools-group.mjs`
- Test: `backend/test/session-inventory-tools-group.test.mjs`

**Interfaces:**
- Produces: `summarizeCodexNativeSession({ absolutePath, relativePath, stat, activeNativeSessionIds })`
- Returns: `{ session_id, title, updated_at, cwd, message_count, last_assistant_message, status, attachable, relative_path, size_bytes, is_test_session }`

- [ ] **Step 1: Write a failing parser test**

Create a temporary JSONL session containing `session_meta`, an environment-only user message, a real user objective, two assistant messages, and a terminal event. Assert that the summary selects the real objective as title, extracts cwd, counts user/assistant messages, returns the final assistant message, and reports `finished`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test backend/test/session-inventory-tools-group.test.mjs
```

Expected: FAIL because the summary/list implementation does not exist.

- [ ] **Step 3: Implement bounded summarization**

Parse JSONL line-by-line without loading unbounded transcript content. Extract:

```js
{
  session_id,
  title,
  updated_at: stat.mtime.toISOString(),
  cwd,
  message_count,
  last_assistant_message,
  status,
  attachable: true,
  relative_path,
  size_bytes: stat.size,
  is_test_session,
}
```

Use the first non-environment, non-internal, non-test user message for the title. Normalize whitespace and cap title and assistant preview lengths. Treat active manager evidence as `running`; terminal JSONL evidence as `finished`; otherwise `idle`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same test command. Expected: PASS.

- [ ] **Step 5: Commit parser behavior**

```bash
git add backend/src/tool-groups/session-inventory-tools-group.mjs backend/test/session-inventory-tools-group.test.mjs
git commit -m "feat: summarize native Codex sessions"
```

### Task 2: Aggregated session list function and filtering

**Files:**
- Modify: `backend/src/tool-groups/session-inventory-tools-group.mjs`
- Test: `backend/test/session-inventory-tools-group.test.mjs`

**Interfaces:**
- Produces: `listCodexNativeSessions({ codexHome, limit, includeTestSessions })`
- Returns: `{ sessions, count, filtered_test_sessions, errors }`

- [ ] **Step 1: Write failing list tests**

Create multiple session files with different mtimes, including a valid business session, a `__gptwork_test_invalid_arg__` session, and malformed JSONL. Assert newest-first sorting, default test filtering, explicit inclusion with `includeTestSessions: true`, limit enforcement, and per-file error isolation.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test backend/test/session-inventory-tools-group.test.mjs
```

Expected: FAIL because `listCodexNativeSessions` is absent.

- [ ] **Step 3: Implement recursive discovery and aggregation**

Reuse `resolveSessionsRoot`, `safeSessionPath`, and `nativeSessionIdFromPath`. Recursively discover `.jsonl` files, sort by mtime descending, summarize each file, filter test sessions by default, apply the bounded limit, and return non-fatal item errors without transcript data.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same test command. Expected: PASS.

- [ ] **Step 5: Commit aggregation behavior**

```bash
git add backend/src/tool-groups/session-inventory-tools-group.mjs backend/test/session-inventory-tools-group.test.mjs
git commit -m "feat: list enriched native Codex sessions"
```

### Task 3: MCP exposure and schema

**Files:**
- Modify: `backend/src/tool-groups/session-inventory-tools-group.mjs`
- Modify: `backend/src/server-tools.mjs`
- Test: `backend/test/session-inventory-tools-group.test.mjs`

**Interfaces:**
- Produces MCP tool: `codex_native_sessions_list`
- Input: `{ limit?: integer, include_test_sessions?: boolean }`
- Output delegates to `listCodexNativeSessions`.

- [ ] **Step 1: Write failing tool exposure tests**

Assert the public tool name and JSON schema are present, the handler exists, scope enforcement matches other read-only session tools, and the handler maps `include_test_sessions` to the internal camelCase option.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test backend/test/session-inventory-tools-group.test.mjs
```

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Register handler and allowlists**

Add `codex_native_sessions_list` to the session inventory tool definitions and relevant `server-tools.mjs` exposure allowlists. Require the existing `workspace:read` scope and return structured JSON.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same test command. Expected: PASS.

- [ ] **Step 5: Commit MCP exposure**

```bash
git add backend/src/tool-groups/session-inventory-tools-group.mjs backend/src/server-tools.mjs backend/test/session-inventory-tools-group.test.mjs
git commit -m "feat: expose native Codex session list"
```

### Task 4: Regression, real-data verification, and deployment

**Files:**
- Verify only unless a defect is discovered.

**Interfaces:**
- Consumes: `codex_native_sessions_list`
- Verifies compatibility with: `codex_native_session_attach`

- [ ] **Step 1: Run related regression suite**

```bash
node --test backend/test/session-inventory-tools-group.test.mjs backend/test/codex-tui-session-manager.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 2: Verify against real native Codex sessions**

Invoke `listCodexNativeSessions` against the configured Codex home and confirm the business session appears with a meaningful Chinese title, cwd, non-zero message count, final assistant preview, and `idle` or evidence-backed lifecycle status. Confirm test sessions are absent by default.

- [ ] **Step 3: Verify direct attach compatibility without mutating history**

Confirm every returned `session_id` matches the UUID derived from its JSONL filename and is accepted by the existing attach path. Do not send a prompt during this verification.

- [ ] **Step 4: Restart and verify runtime commit**

Use the project safe restart flow with the final commit SHA, then verify tool exposure from the refreshed MCP registry.

- [ ] **Step 5: Record final verification commit if needed**

Only create an additional commit if verification reveals and fixes a defect; otherwise retain the Task 3 commit as the implementation head.
