# GPTWork Widget Card v2

## Overview

The GPTWork Apps SDK Card v2 transforms structured tool results into compact, visually-readable HTML cards for the ChatGPT UI. It uses the ChatGPT Apps SDK widget protocol to render runtime status, task results, queue items, diff summaries, handoff plans, and shell transcripts in a compact, readable card.

## Resource URI

```text
ui://widget/gptwork-card-v2.html
```

Legacy v1 card is available at:

```text
ui://widget/gptwork-card-v1.html
```

## Resource Metadata

Exposed via `resources/list` for ChatGPT Apps SDK discovery:

| Field | Value |
|---|---|
| `uri` | `ui://widget/gptwork-card-v2.html` |
| `name` | `GPTWork Apps SDK Card (v2)` |
| `mimeType` | `text/html` |
| `openai/widgetDescription` | Description of the card's rendering purpose |
| `openai/widgetPrefersBorder` | `true` |
| `openai/widgetDomain` | Array of tool names that use this card |
| `openai/widgetCSP` | Content Security Policy for inline styles/scripts |

## Tool Descriptor Metadata

Tools that return structured results use two properties in their MCP tool descriptor `_meta`:

```json
{
  "_meta": {
    "openai/outputTemplate": "ui://widget/gptwork-card-v2.html",
    "ui": {
      "resourceUri": "ui://widget/gptwork-card-v2.html"
    }
  }
}
```

Both properties point to the v2 card URI. The `ui.resourceUri` conforms to the Apps SDK resource reference convention.

## Structured Content Contract

The v2 card reads the following fields from `structuredContent` (also reads `window.openai.toolOutput` or `window.openai.structuredContent`):

| Field | Type | Description |
|---|---|---|
| `title` | string | Card headline (falls back to `summary` / `name`) |
| `status` | string | Rendered as a colored badge |
| `summary` | string | Subtitle or one-line summary |
| `keyValues` / `key_values` | Array or Object | Key-value table |
| `items` / `list` | Array | Item list |
| `changed_files` | Array | File path list (limit 20) |
| `staged_count` | number | Staged file count (diff stats) |
| `unstaged_count` | number | Unstaged file count (diff stats) |
| `total_changes` | number | Total change count |
| `diff_excerpt` | string | Diff excerpt preview (limit 1200 chars) |
| `diff_truncated` | boolean | Whether diff was truncated |
| `warnings` | Array | Warning messages |
| `errors` | Array | Error messages |
| other fields | any | Raw JSON fallback (collapsible) |

## Badge Color Mapping

| CSS Class | Status Values |
|---|---|
| `.badge.ok` | ok, pass, completed, success, enabled, healthy, connected, active, clean, true, running, loaded |
| `.badge.warn` | warn, warning, pending, queued, waiting, ready, started, in_progress |
| `.badge.fail` | fail, failed, error, crashed, stopped, disabled, dirty, stale, missing, blocked |
| `.badge.cancelled` | cancelled, skipped, timeout, timed_out |
| `.badge.info` | waiting_for_lock, waiting_for_review (default) |

## Tools Using v2 Card

At least 10 high-frequency tools use the v2 card:

- `runtime_status`
- `gptwork_doctor`
- `gptwork_self_test`
- `show_changes`
- `get_task`
- `list_tasks`
- `create_encoded_goal`
- `get_goal_context`
- `list_goals`
- `read_handoff`
- `list_goal_queue`
- `start_next_queued_goal`

All tool descriptors include both `openai/outputTemplate` and `ui.resourceUri` pointing to `ui://widget/gptwork-card-v2.html`.

## v1 Compatibility

The v1 card (`ui://widget/gptwork-card-v1.html`) is preserved and unchanged. Tools that previously referenced it have been migrated to v2. The v1 card remains available for backward compatibility and can be referenced by legacy ChatGPT App SDK clients.

## Raw JSON Fallback

If `structuredContent` has no recognized fields (status, summary, keyValues, items, changed_files, errors, warnings, staged_count, diff_excerpt), the card displays the complete JSON object as a formatted code block. Otherwise, the raw JSON is available via a "Show raw JSON" toggle button.

## Source

The v2 card HTML is served from:

```text
backend/src/widget-card-v2.html
```

The v1 card HTML is inline in:

```text
backend/src/mcp-tooling.mjs (readResource function)
```
