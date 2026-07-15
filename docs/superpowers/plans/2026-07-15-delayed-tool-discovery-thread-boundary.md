# Delayed Tool Discovery and Thread Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a canonical searchable tool descriptor catalog with delayed discovery APIs, and make root Goal the stable user-visible Thread while follow-up/repair work remains internal lineage.

**Architecture:** Extend the existing tool registry so every registered tool has one normalized descriptor consumed by MCP listing, capability classification, and search. Add read-only `tool_search` and `tool_describe` tools while preserving full `tools/list` compatibility by default. Add a thread identity/view layer that derives stable user-facing titles from `root_goal_id`, while retaining internal child titles and task lineage for audit.

**Tech Stack:** Node.js ESM, MCP JSON-RPC, node:test, existing GPTWork state store and tool-group conventions.

## Global Constraints

- Do not bypass the canonical task transition service.
- Preserve existing MCP `tools/list` behavior unless delayed exposure is explicitly enabled.
- Tool discovery is read-only, deterministic, bounded, and never invokes tools.
- Root Goal is the durable user Thread identity; repairs, retries, verification, and integration remain child Goals/Tasks.
- Preserve internal titles for audit; expose a separate stable user-facing thread title.
- Add tests before implementation and run targeted plus full test suites.

---

### Task 1: Canonical tool descriptor catalog

**Files:**
- Modify: `backend/src/tool-registry.mjs`
- Create: `backend/src/tool-discovery/tool-catalog.mjs`
- Test: `backend/test/tool-catalog.test.mjs`

**Interfaces:**
- Produces `normalizeToolDescriptor(name, tool)` and `createToolCatalog(tools)`.
- Catalog supports `list()`, `get(name)`, and `search(query,{limit,audience,mode,tags})`.

- [ ] Write failing unit tests for descriptor normalization, deterministic ranking, filters, bounded results, and no handler exposure.
- [ ] Run the test and confirm failure.
- [ ] Implement tokenization and weighted lexical ranking over name, tags, description, audience, and modes.
- [ ] Run tests and confirm pass.

### Task 2: MCP delayed discovery tools

**Files:**
- Create: `backend/src/tool-groups/tool-discovery-tools-group.mjs`
- Modify: `backend/src/server-tools.mjs`
- Modify: `backend/src/gptwork-server.mjs` or the RPC listing boundary where necessary
- Test: `backend/test/tool-discovery-tools-group.test.mjs`
- Test: `backend/test/mcp-core.test.mjs`

**Interfaces:**
- `tool_search({query,limit,audience,mode,tags,include_schema})`
- `tool_describe({names,include_schema})`

- [ ] Write failing tests proving discovery tools are always visible and return bounded descriptors.
- [ ] Implement the tool group using the final assembled tool registry.
- [ ] Add optional `GPTWORK_DELAYED_TOOL_DISCOVERY=true` exposure mode that lists bootstrap tools plus explicitly requested/discovered names, while default remains backward compatible.
- [ ] Verify `tools/call` remains authoritative and undiscovered tools cannot be invoked in delayed mode unless allowlisted for the session/request.
- [ ] Run MCP and card smoke tests.

### Task 3: Unify capability metadata

**Files:**
- Modify: `backend/src/ephemeral-execution/tool-capability-registry.mjs`
- Modify: `backend/src/tool-registry.mjs`
- Test: `backend/test/tool-capability-registry.test.mjs`

**Interfaces:**
- Tool metadata annotations carry `side_effect`, `idempotency`, `execution_class`, `authority`, `parallel_safe`, and `requires_lock`.
- Ephemeral registry consumes normalized descriptors instead of a duplicated hard-coded truth source, retaining safe fallback defaults.

- [ ] Write failing tests for metadata-driven classification and unknown-tool safe fallback.
- [ ] Implement descriptor import/registration.
- [ ] Run ephemeral batch tests.

### Task 4: Stable user Thread identity

**Files:**
- Create: `backend/src/thread/thread-view.mjs`
- Modify: `backend/src/goal-lifecycle.mjs`
- Modify: `backend/src/goal-task-goals.mjs` and repair/follow-up factories that create child goals
- Modify relevant card/view modules
- Test: `backend/test/thread-view.test.mjs`
- Test: `backend/test/repair-loop.test.mjs`

**Interfaces:**
- `resolveRootGoal(state, goal)`.
- `buildThreadView(state, goal)` returns `thread_id`, `root_goal_id`, `thread_title`, `internal_title`, `phase`, `iteration`, and `is_internal_child`.
- New root goals default `root_goal_id` to their own id after ID allocation; child goals inherit root identity.

- [ ] Write failing tests for root, repair, follow-up, retry, and legacy goals.
- [ ] Implement non-mutating legacy fallback and canonical persistence for newly created goals.
- [ ] Add stable thread fields to user-facing views without deleting internal titles.
- [ ] Run goal, workstream, repair, queue, and card tests.

### Task 5: End-to-end acceptance and documentation

**Files:**
- Create: `docs/delayed-tool-discovery.md`
- Create: `docs/thread-subagent-boundary.md`
- Modify: `docs/architecture.md`
- Modify: `backend/.env.example`
- Test: `backend/test/delayed-tool-thread-e2e.test.mjs`

- [ ] Add E2E tests: search → describe → permitted invocation, and root goal → repair child → stable thread view.
- [ ] Run `npm run check:syntax`, `npm run check:imports`, targeted tests, then full `npm test`.
- [ ] Run `npm run release:state-boundary:gate` when present and valid.
- [ ] Inspect git diff for unrelated changes and preserve the pre-existing census report modification.
