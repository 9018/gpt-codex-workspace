# GPTWork Productization Design

## Goal

Implement the `gptwork_p0_p1_p2_goal` bundle as a compatible productization pass: a user-facing CLI, bounded default tool surface, first-step project context, compact outputs, tracked agent runs and handoffs, metadata-driven tool registration, richer schemas, event logging, a hook point, and one Apps SDK widget resource.

## Scope

P0 is the primary delivery path and must be usable on its own. P1 and P2 are implemented as small compatible layers over the existing JSON state store and MCP tool registry, not as a rewrite of worker execution, GitHub sync, or storage. Existing public tool names and current request/response paths remain valid.

## Architecture

The implementation keeps `createGptWorkServer()` as the composition root. New functionality is added through focused modules:

- CLI commands live under `backend/bin/gptwork.mjs` and call local HTTP/MCP endpoints or read runtime configuration directly.
- Tool mode filtering happens after group creation in `server-tools.mjs`, using metadata on tool descriptors where available and a central fallback map for existing tools.
- `open_project_context` is a new tool group backed by `project-context-service.mjs`, which reads bounded repository facts, state summaries, worker status, and discovered scripts without scanning large source trees.
- Agent runs and handoff files are stored in the existing JSON state plus `.gptwork/handoff/*` artifacts. This satisfies traceability while keeping the storage migration reversible.
- P2 registry/schema/event/hook/widget support is introduced as additive infrastructure. Old `createTool(description, inputSchema, handler)` calls continue to work, while new object-form tool descriptors can carry metadata, examples, output cards, and Apps SDK output templates.

## Data Flow

MCP startup builds config, store, registry, and tool groups as before. The tool registry normalizes both old and new descriptor forms. `createTools()` returns a filtered tool map based on `GPTWORK_TOOL_MODE`, defaulting to `standard`. Tool calls keep returning structured content plus a compact text summary. Lifecycle actions append JSONL events through an event log helper, and a minimal hook bus lets existing notification/GitHub-adjacent workflows observe events without hard coupling.

## Error Handling

New CLI commands must prefer compact actionable output and non-zero exits for local failures. MCP tools return structured errors through the existing JSON-RPC handler. File reads for context, handoff, events, and status are bounded and degrade to explicit `missing` or `unavailable` fields instead of throwing where possible.

## Testing

Tests cover red-green behavior for CLI parsing/status output, tool mode filtering, `open_project_context`, agent run lifecycle, handoff/watch dry-run, `show_changes`, richer schema generation, event log append/read, hook dispatch, tool metadata, and Apps SDK resource listing. Final verification requires backend syntax checks and the backend test suite, then a backend restart with health confirmation.

## Self-Review

No placeholders remain. The design deliberately chooses the smallest compatible implementation for P1/P2 rather than a full worker pipeline rewrite, matching the goal bundle's “small reversible goal-aligned change” autonomy policy and the non-goal of rewriting state storage.
