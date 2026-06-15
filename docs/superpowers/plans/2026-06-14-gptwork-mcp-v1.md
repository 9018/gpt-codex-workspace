# GPTWork MCP v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a first usable backend MCP service for GPTWork with token auth, project/workspace management, task queue, hosted workspace tools, SSH adapter support, and Codex/ChatGPT-compatible MCP HTTP.

**Architecture:** Implement a dependency-light Node.js backend under `backend/` using built-in Node modules. Expose streamable HTTP MCP at `/mcp`, persist state in JSON, keep workspace adapters isolated, and deploy to `10.0.1.103:/home/a9017/mcp/gpt-codex-workspace`.

**Tech Stack:** Node.js 22, built-in `node:test`, built-in HTTP server, JSON state store, systemd user service.

---

### Task 1: Backend Test Harness

**Files:**
- Create: `backend/package.json`
- Create: `backend/test/root-guard.test.mjs`
- Create: `backend/test/mcp-protocol.test.mjs`

- [ ] Write tests for root path guarding and MCP initialize/tools responses.
- [ ] Run `npm test` and verify the tests fail because implementation files do not exist.
- [ ] Create the minimal backend modules.
- [ ] Run `npm test` and verify the tests pass.

### Task 2: Workspace and Task Tools

**Files:**
- Create: `backend/src/state-store.mjs`
- Create: `backend/src/tools.mjs`
- Create: `backend/test/task-tools.test.mjs`
- Create: `backend/test/workspace-tools.test.mjs`

- [ ] Write failing tests for project listing, workspace info, task creation/update, file write/read/search, and shell execution.
- [ ] Implement state persistence and hosted workspace adapter.
- [ ] Verify tests pass.

### Task 3: SSH Adapter and Browser-HTTP Tools

**Files:**
- Create: `backend/src/ssh-adapter.mjs`
- Create: `backend/src/browser-http.mjs`
- Create: `backend/test/ssh-adapter.test.mjs`
- Create: `backend/test/browser-http.test.mjs`

- [ ] Write failing tests for SSH command construction/root guard and basic browser HTTP session lifecycle.
- [ ] Implement SSH/SFTP command adapter wrappers and browser HTTP session state.
- [ ] Verify tests pass.

### Task 4: Deployment Assets and Plugin Updates

**Files:**
- Create: `backend/systemd/gptwork-mcp.service`
- Create: `backend/.env.example`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `plugins/gpt-codex-workspace/mcp/server.mjs`

- [ ] Document deployment and runtime environment.
- [ ] Ensure plugin proxy handles remote MCP errors and SSE responses.
- [ ] Verify JSON and Node syntax.

### Task 5: Remote Deployment and Verification

**Remote path:**
- Replace: `/home/a9017/mcp/gpt-codex-workspace`

- [ ] Upload repository to remote host.
- [ ] Install or update the user systemd service.
- [ ] Start backend on localhost.
- [ ] Verify `/health`.
- [ ] Verify `/mcp` initialize, tools/list, project, task, workspace file, shell, and browser-http flows.
- [ ] Verify SSH adapter reports a structured auth/connect error when no usable SSH workspace credentials are configured.

### Task 6: Publish to GitHub

**Repository:**
- `9018/gpt-codex-workspace`

- [ ] Commit and push implementation files.
- [ ] Read back key files from GitHub.
- [ ] Report verification evidence and remaining limitations.
