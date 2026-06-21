# GPTWork Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the P0/P1/P2 productization bundle while preserving existing GPTWork MCP compatibility.

**Architecture:** Add compatibility-first layers around the current server: object-form tool metadata with mode filtering, a first-step project context service, a user CLI, JSON-state agent runs, handoff artifacts, JSONL events, a small hook bus, and one Apps SDK widget resource. Existing tool names, state paths, worker paths, and JSON-RPC behavior remain valid.

**Tech Stack:** Node.js ESM, built-in `node:test`, current JSON StateStore, MCP JSON-RPC/SSE helpers, local filesystem artifacts.

---

### Task 1: Registry, Schema, Tool Mode, Widget Resource

**Files:**
- Modify: `backend/src/tool-registry.mjs`
- Modify: `backend/src/mcp-tooling.mjs`
- Modify: `backend/src/runtime-config.mjs`
- Modify: `backend/src/server-tools.mjs`
- Modify: `backend/src/gptwork-server.mjs`
- Test: `backend/test/productization-registry.test.mjs`

- [ ] Write tests for object-form `createTool`, richer schemas, default `standard` mode filtering, and Apps SDK resource metadata.
- [ ] Run the focused test and confirm it fails because the features are missing.
- [ ] Implement backward-compatible registry normalization, rich `schema()` descriptors, `GPTWORK_TOOL_MODE`, central mode filtering, and `resources/list` for `ui://widget/gptwork-card-v1.html`.
- [ ] Run the focused test and confirm it passes.

### Task 2: P0 Project Context and CLI

**Files:**
- Create: `backend/src/project-context-service.mjs`
- Create: `backend/src/tool-groups/project-context-tools-group.mjs`
- Create: `backend/bin/gptwork.mjs`
- Modify: `backend/src/server-tools.mjs`
- Modify: `backend/package.json`
- Test: `backend/test/productization-p0.test.mjs`

- [ ] Write tests for `open_project_context`, CLI `doctor/status/settings`, and compact command output.
- [ ] Run the focused test and confirm it fails because the CLI/tool do not exist.
- [ ] Implement bounded project context collection, MCP tool registration, executable CLI commands, and `package.json` `bin` mapping.
- [ ] Run the focused test and confirm it passes.

### Task 3: P1 Agent Runs, Handoff, Changes

**Files:**
- Create: `backend/src/agent-run-service.mjs`
- Create: `backend/src/handoff-service.mjs`
- Create: `backend/src/tool-groups/agent-run-tools-group.mjs`
- Modify: `backend/src/state-store.mjs`
- Modify: `backend/src/server-tools.mjs`
- Modify: `backend/bin/gptwork.mjs`
- Test: `backend/test/productization-p1.test.mjs`

- [ ] Write tests for `create_agent_run`, `list_agent_runs`, `get_agent_run`, `append_agent_event`, `complete_agent_run`, `handoff_to_agent`, `read_handoff`, `show_changes`, and `gptwork watch-handoff --dry-run`.
- [ ] Run the focused test and confirm it fails because agent run/handoff behavior is absent.
- [ ] Implement JSON-state agent run helpers, handoff artifact read/write helpers, MCP tools, and CLI dry-run watcher.
- [ ] Run the focused test and confirm it passes.

### Task 4: P2 Events and Hooks

**Files:**
- Create: `backend/src/event-log-service.mjs`
- Create: `backend/src/hook-service.mjs`
- Modify: `backend/src/agent-run-service.mjs`
- Modify: `backend/src/goal-task-lifecycle.mjs`
- Test: `backend/test/productization-p2.test.mjs`

- [ ] Write tests for JSONL lifecycle events and hook dispatch on agent run completion.
- [ ] Run the focused test and confirm it fails because event/hook infrastructure is absent.
- [ ] Implement append-only event logging and a minimal hook bus, then connect agent run lifecycle to it.
- [ ] Run the focused test and confirm it passes.

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/chatgpt-prompting-guide.md`
- Modify: `docs/current-status.md`

- [ ] Update README first viewport to CLI-first setup/start/status/doctor and recommend `open_project_context` as ChatGPT's first tool.
- [ ] Update ChatGPT prompting/current status docs with tool mode, context, handoff, and compact output notes.
- [ ] Run `npm --prefix backend run check:syntax`.
- [ ] Run `npm --prefix backend test`.
- [ ] Restart the backend and verify `/health` responds.

## Self-Review

Every P0 acceptance item maps to Tasks 1, 2, and 5. P1 acceptance maps to Task 3 plus Task 4 event evidence. P2 acceptance maps to Tasks 1 and 4, with the widget resource handled in Task 1. The plan avoids placeholders and keeps compatibility with legacy tool descriptors and state shape.
