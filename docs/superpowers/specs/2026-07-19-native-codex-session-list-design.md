# Native Codex Session List Design

## Goal

Expose a first-class MCP tool that presents native Codex sessions as a product-ready list comparable to Codex's Resume screen, while adding richer metadata and direct resume support.

## Public Tool

Add `codex_native_sessions_list`.

### Input

```json
{
  "limit": 20,
  "include_test_sessions": false
}
```

- `limit`: integer, default `20`, bounded to a safe maximum consistent with existing session inventory limits.
- `include_test_sessions`: boolean, default `false`. When false, sessions whose only effective user prompt is `__gptwork_test_invalid_arg__` are excluded.

### Output

```json
{
  "sessions": [
    {
      "session_id": "019f7682-685e-79d0-99ef-2ce9416dde7d",
      "title": "分析项目代码，做实验测试项目执行能力……",
      "updated_at": "2026-07-18T18:55:42.435Z",
      "cwd": "/home/a9017/mcp/workspace/gpt-codex-workspace",
      "message_count": 42,
      "last_assistant_message": "Tests run individually...",
      "status": "idle",
      "attachable": true
    }
  ]
}
```

## Field Semantics

### `session_id`

Derived from the UUID suffix in the native Codex JSONL filename. It is accepted directly by `codex_native_session_attach`.

### `title`

Derived from the first effective user task, excluding environment-only messages and internal wrappers. For goal-backed sessions, extract the `<objective>` body before falling back to the raw user message. Normalize whitespace and truncate only for display safety; preserve enough text to match Codex Resume behavior.

### `updated_at`

Use the JSONL file modification time in ISO-8601 format.

### `cwd`

Read from native session metadata or environment context. Return `null` when unavailable.

### `message_count`

Count effective user and assistant messages only. Exclude system, developer, environment-only, event, and tool records.

### `last_assistant_message`

Return the latest effective assistant text, normalized and safely truncated. Return `null` when no assistant response exists.

### `status`

Use exactly one of:

- `running`: an active WorkMCP Codex TUI/control session is bound to this native session and its process is active.
- `finished`: no active control process exists and the native JSONL contains an explicit terminal completion or termination event.
- `idle`: the session is not currently active and no explicit terminal event proves completion.

Status is evidence-based. Absence of recent writes alone must not be treated as `finished`.

### `attachable`

`true` when a valid native session ID and JSONL file exist. Running sessions remain attachable only when the existing manager can safely return or reuse the current control binding; otherwise return `false`.

## Architecture

Implement parsing and aggregation in the existing session inventory tool group, reusing:

- configured Codex sessions root resolution;
- safe path validation;
- native session ID extraction;
- existing Codex TUI session manager status and resume behavior.

Keep `list_codex_sessions_metadata` unchanged for backward compatibility. The new tool is the rich product-facing API.

## Data Flow

1. Discover recent JSONL files under the configured Codex sessions root.
2. Sort by modification time descending.
3. Parse each file with bounded reads sufficient to obtain metadata, the first effective user task, message counts, latest assistant text, and terminal evidence.
4. Correlate native session IDs with active WorkMCP control sessions.
5. Apply the test-session filter.
6. Return up to `limit` enriched records.

## Error Handling

- Missing sessions directory returns an empty list.
- One malformed or unreadable JSONL file does not fail the whole request; skip it or return conservative nullable fields.
- Never allow path traversal outside the configured sessions root.
- Never expose tokens, cookies, credentials, system prompts, developer prompts, or unrelated internal records.
- Bound file reads and output field lengths.

## Tool Exposure

Expose `codex_native_sessions_list` in the same MCP modes and allowlists as the existing native session read/attach tools.

## Testing

Add tests covering:

1. Complete enriched list fields for a normal session.
2. Goal objective extraction into `title`.
3. Environment-only records excluded from title and message count.
4. Latest assistant response extraction.
5. Default filtering of `__gptwork_test_invalid_arg__` sessions.
6. Inclusion when `include_test_sessions=true`.
7. `running`, `idle`, and `finished` status classification.
8. Empty/missing sessions directory.
9. Malformed JSONL isolation.
10. Tool schema, handler registration, and MCP allowlist exposure.
11. Returned `session_id` can be passed directly to the existing attach flow.

## Compatibility and Scope

- Do not remove or change `list_codex_sessions_metadata`.
- Do not build a separate UI in this change.
- Do not add a second resume implementation; reuse `codex_native_session_attach`.
- Do not infer completion merely from inactivity.
