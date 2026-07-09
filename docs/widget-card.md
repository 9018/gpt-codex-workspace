# GPTWork Tool Card v5

## Overview

The GPTWork Apps SDK Tool Card v5 transforms structured tool results into compact, visually-readable HTML cards for the ChatGPT UI. It uses the ChatGPT Apps SDK widget protocol to render runtime status, task results, queue items, diff summaries, handoff plans, and shell transcripts in a compact, readable card.

## Three-Layer Contract

GPTWork implements a strict three-layer data contract to keep card payloads bounded and prevent accidental data leakage.

### Layer 1: ChatGPT Query Summary/Detail (modelPayload)

The `structuredContent` field in every MCP tool result contains the **modelPayload** — a bounded set of fields that the language model sees to reason about the result. This is NOT the raw tool output.

```json
{
  "structuredContent": {
    "gptwork_tool": "runtime_status",
    "gptwork_title": "Runtime status",
    "gptwork_type": "tool_result",
    "gptwork_payload_hash": "a1b2c3d4e5f67890",
    "gptwork_card_instance_id": "runtime_status:a1b2c3d4e5f67890",
    "summary": "Worker running, 0 active tasks",
    "status": "ok",
    "rawAvailable": true
  }
}
```

The modelPayload explicitly **excludes raw deep data** such as full stdout/stderr, full task results, full queue objects, large diffs, transcripts, shell snapshots, and debug blobs. A small set of **controlled compatibility fields** may be exposed for specific operational tools so ChatGPT can reason about task IDs, lock summaries, worker status, runtime status, and doctor next actions without reading raw state. It includes:

| Field | Type | Description |
|---|---|---|
| `gptwork_tool` | string | Tool name that produced the result |
| `gptwork_title` | string | Human-readable display title |
| `gptwork_type` | string | Always `"tool_result"` |
| `gptwork_payload_hash` | string | Semantic hash to detect changes in underlying data |
| `gptwork_card_instance_id` | string | Instance identifier combining tool name and hash |
| `summary` | string | One-line result summary |
| `status` | string | Result status (ok, warning, error, info) |
| `rawAvailable` | boolean | Always `true` — signals that deep data can be fetched via explicit tools |
| `card` | object | **Backward compat**: embedded card view model (see Layer 2) |
| tool-specific compact fields | object/scalars | Controlled compatibility fields for tools such as `create_task`, `get_task`, `run_assigned_codex_tasks`, `runtime_status`, `worker_status`, `repo_lock_status`, `list_repo_locks`, `gptwork_doctor`, and `open_project_context` |

The `card` field inside `structuredContent` exists for backward compatibility with v2 clients that expect the card model inside the structured content. New code should prefer `_meta.gptwork_card`.

Tool-specific compatibility fields are intentionally bounded. For example, task payloads use a compact task projection, repo lock tools expose lock summaries, and runtime/doctor tools expose queue/worker/next-action summaries. They do not reintroduce full raw payload spreading.

### Layer 2: V5 User Card View (cardPayload)

The `_meta.gptwork_card` field in every MCP tool result contains the **cardPayload** — the full card view model rendered by the widget HTML. This is the data the ChatGPT Apps SDK card actually displays.

```json
{
  "_meta": {
    "resourceUri": "ui://widget/gptwork-tool-card-v5.html",
    "tool": "runtime_status",
    "gptwork_card": {
      "card_version": "gptwork-card-v1",
      "card_type": "runtime_health",
      "title": "Runtime status",
      "status": "ok",
      "severity": "ok",
      "summary": "Worker running, 0 active tasks",
      "identity": {
        "tool": "runtime_status",
        "payload_hash": "a1b2c3d4e5f67890",
        "card_instance_id": "runtime_status:a1b2c3d4e5f67890"
      },
      "key_values": [
        { "key": "PID", "value": "12345" },
        { "key": "Commit", "value": "6ce329f" }
      ],
      "sections": [],
      "actions": [],
      "diagnostics": [],
      "raw_available": true
    }
  }
}
```

The widget reads from `_meta.gptwork_card` first (v5 preferred path), falls back to `structuredContent.card` (backward compat), then legacy `structuredContent` key/value lists.

The cardPayload **excludes** all raw evidence blobs:

| Excluded Field | Reason |
|---|---|
| `stdout` | Raw STDOUT is deep inspection, not card data |
| `stderr` | Raw STDERR is deep inspection, not card data |
| `raw` | Raw tool result JSON is deep inspection |
| `task` | Full task object contains evidence, handoff data, and debug output |
| `queue` | Raw queue object with task-level policy detail |

### Layer 3: Explicit Deep Inspection

The `rawAvailable: true` flag in the modelPayload signals that deep data exists but must be fetched through explicit tool calls. This prevents the card and the model from accidentally seeing data that belongs only in dedicated inspection tools.

Deep inspection tools (not card data):

- `get_task` — full task result with evidence, verification detail, stdout/stderr
- `show_changes` — full diff with file contents
- `read_handoff` — complete handoff transcript
- `gptwork_doctor` — runtime diagnostics with environment detail
- `runtime_status` — full runtime object with queue policy detail

These tools return cardPayload for quick reference AND modelPayload with `rawAvailable: true`. Some operational tools also include bounded compatibility fields in modelPayload, but deep data remains accessible only through their dedicated `content[0].text` or additional tool-specific accessors.

## Widget Version vs Card Schema Version

GPTWork maintains two separate version tracks:

| Concept | Identifier | Location | Purpose |
|---|---|---|---|
| **Widget version** | `gptwork-tool-card-v5` | Resource URI (`ui://widget/gptwork-tool-card-v5.html`) | Cache-busting identifier for the HTML widget served to ChatGPT Apps SDK. Incremented when the widget rendering code, DOM structure, or CSS changes. |
| **Card schema version** | `gptwork-card-v1` | Inside card view model (`card_version` field) | Data schema version of the card payload structure. Incremented when the JSON contract (required/optional fields, type changes) changes. |

The widget version is what the MCP connector sees as the resource URI — it determines whether the client re-fetches the HTML or uses a cached copy. The card schema version is what the widget JavaScript sees inside the payload — it determines how the renderer interprets the data.

Legacy widget resource URIs remain readable for cached clients:

| URI | Status |
|---|---|
| `ui://widget/gptwork-tool-card-v5.html` | **Current** — primary cache-busted URI |
| `ui://widget/gptwork-tool-card-v4.html` | Legacy alias |
| `ui://widget/gptwork-tool-card-v3.html` | Legacy alias |
| `ui://widget/gptwork-tool-card-v2.html` | Legacy alias |
| `ui://widget/gptwork-tool-card-v1.html` | Legacy alias |
| `ui://widget/gptwork-card-v2.html` | Legacy v2 card alias |
| `ui://widget/gptwork-card-v1.html` | Legacy v1 card alias |

All legacy URIs redirect to the same v5 widget HTML. There is no separate v2/v3/v4 widget — the version in the URI is purely a cache-busting signal.

## Resource URI

```text
ui://widget/gptwork-tool-card-v5.html
```

## Resource Metadata

Exposed via `resources/list` for ChatGPT Apps SDK discovery:

| Field | Value |
|---|---|
| `uri` | `ui://widget/gptwork-tool-card-v5.html` |
| `name` | `GPTWork Apps SDK Card (v5)` |
| `mimeType` | `text/html;profile=mcp-app` |
| `openai/widgetDescription` | Description of the card's rendering purpose |
| `openai/widgetPrefersBorder` | `true` |
| `openai/widgetDomain` | Widget origin domain |
| `openai/widgetCSP` | Content Security Policy for inline styles/scripts |

## Tool Descriptor Metadata

Tools that return structured results use two properties in their MCP tool descriptor `_meta`:

```json
{
  "_meta": {
    "openai/outputTemplate": "ui://widget/gptwork-tool-card-v5.html",
    "ui": {
      "resourceUri": "ui://widget/gptwork-tool-card-v5.html"
    }
  }
}
```

Both properties point to the v5 card URI. The `ui.resourceUri` conforms to the Apps SDK resource reference convention.

## Tool Result Metadata

Every card-enabled tool call returns structured content and card metadata:

```json
{
  "content": [
    { "type": "text", "text": "compact text summary..." }
  ],
  "structuredContent": {
    "gptwork_tool": "...",
    "gptwork_title": "...",
    "gptwork_type": "tool_result",
    "gptwork_payload_hash": "...",
    "gptwork_card_instance_id": "...",
    "summary": "...",
    "status": "...",
    "rawAvailable": true,
    "card": { "card_version": "gptwork-card-v1", ... }
  },
  "_meta": {
    "tool": "...",
    "resourceUri": "ui://widget/gptwork-tool-card-v5.html",
    "gptwork_card": { "card_version": "gptwork-card-v1", ... }
  },
  "isError": false
}
```

## Card View Model Schema (gptwork-card-v1)

When `cardPayload` is present, it uses the following view model structure:

| Field | Type | Description |
|---|---|---|
| `card_version` | string | Fixed: `"gptwork-card-v1"` |
| `card_type` | string | Card type identifier (e.g. `runtime_health`, `task_execution`, `task_list`, `generic`) |
| `title` | string | Card headline |
| `subtitle` | string | Optional secondary heading |
| `status` | string | Status badge label (ok, warning, fail, info, cancelled) |
| `severity` | string | Mapped severity from status (ok, warning, error, info) |
| `summary` | string | One-line display summary |
| `identity` | object | `{ tool, payload_hash, card_instance_id }` — identity tracking |
| `progress` | object | Optional stage progress: `{ current_stage, stages: [{key, label, status}] }` |
| `key_values` | Array | Key-value table rows: `[{key: string, value: any}]` |
| `sections` | Array | Content sections: `[{title, type (checklist/logs/diff), items[]}]` |
| `actions` | Array | Action buttons: `[{label, tool, args}]` |
| `diagnostics` | Array | Diagnostic messages: `[{severity, message, code}]` |
| `raw_available` | boolean | Whether raw data is accessible via explicit tools |

### Section Types

| Type | Description | Item Shape |
|---|---|---|
| `checklist` | Task checklist items | `[{key, label, status}]` |
| `logs` | Timestamped log entries | `[{time, text}]` |
| `diff` | File diff sections | `[{path, status, diff}]` |

### Badge Color Mapping

| CSS Class | Status Values |
|---|---|
| `.badge.ok` | ok, pass, completed, success, enabled, healthy, connected, active, clean, true, running, loaded |
| `.badge.warn` | warn, warning, pending, queued, waiting, ready, started, in_progress |
| `.badge.fail` | fail, failed, error, crashed, stopped, disabled, dirty, stale, missing, blocked |
| `.badge.cancelled` | cancelled, skipped, timeout, timed_out |
| `.badge.info` | waiting_for_lock, waiting_for_review (default) |

## Widget Payload Resolution Order

The v5 widget JavaScript resolves rendering data in this order:

1. `_meta.gptwork_card` from `call_tool_result` response metadata (preferred v5 path)
2. `structuredContent.card` from tool result (backward compat path)
3. `structuredContent` from tool result key/value fields (legacy v2 path)
4. `toolOutput` from `window.openai` (legacy widget protocol)
5. `toolResponseMetadata.mcp_tool_result.structuredContent` (metadata path)
6. `widgetState` from rehydrated snapshot (second-open optimization)
7. Raw text content fallback
8. Visible fallback: "GPTWork card loaded. Waiting for tool result..."

## Tools Using v5 Card

At least 21 high-frequency tools use the v5 card:

| Tool | Card Type |
|---|---|
| `runtime_status` | runtime_health |
| `worker_status` | runtime_health |
| `gptwork_doctor` | runtime_health |
| `gptwork_self_test` | self_test |
| `show_changes` | changes |
| `get_task` | task_execution |
| `list_tasks` | task_list |
| `create_encoded_goal` | task_execution |
| `get_goal_context` | goal_context |
| `list_goals` | goal_list |
| `read_handoff` | handoff |
| `context_status` | context_health |
| `project_context_status` | context_health |
| `product_status` | product_health |
| `preview_codex_context` | codex_context |
| `list_goal_queue` | queue_list |
| `get_goal_queue` | queue_list |
| `start_next_queued_goal` | queue_action |
| `enqueue_goal` | queue_action |
| `update_goal_queue_item` | queue_action |
| `cancel_goal_queue_item` | queue_action |

All tool descriptors include both `openai/outputTemplate` and `ui.resourceUri` pointing to `ui://widget/gptwork-tool-card-v5.html`.

## Tool Mode Visibility

The card and its tools are available across tool modes:

| Mode | Queue Tools | Card Metadata |
|---|---|---|
| `minimal` | Hidden | Card enabled for visible tools (health_check, runtime_status, worker_status) |
| `standard` | All six visible | Full card metadata on all card-enabled tools |
| `operator` | Read-only (list/get) | Card metadata on visible tools |
| `codex` | All six visible | Full card metadata on all card-enabled tools |
| `full` | All six visible | Full card metadata on all card-enabled tools |

## Raw JSON Fallback

If the card receives no recognized view model or structured content, it renders a visible fallback message:

> GPTWork card loaded. Waiting for tool result...

If `structuredContent` has no recognized fields (status, summary, keyValues, items, changed_files, errors, warnings, staged_count, diff_excerpt, card), the card displays the complete JSON object as a formatted code block. Otherwise, the raw JSON is available via a "Show raw JSON" toggle button.

## Error Handling

The v5 widget includes an explicit error boundary. If payload access throws an exception, the card renders:

> Renderer error: \<error message\>

This prevents a blank card when the data is malformed.

## Source

The current tool card HTML is served from:

```text
backend/src/apps-sdk-card/widget.html
```

The card view model construction is in:

```text
backend/src/card-view-model.mjs
```

The payload split logic (modelPayload/cardPayload separation) is in:

```text
backend/src/apps-sdk-card/tool-result.mjs
```

## Troubleshooting: Card Not Displaying in ChatGPT

If the v5 card doesn't display in ChatGPT:

1. **Reconnect the MCP connector**: Refresh/reconnect the ChatGPT MCP connector to force re-initialization.
2. **Check tool descriptor `_meta`**: Call `tools/list` and verify high-frequency tools have:
   - `_meta["openai/outputTemplate"] === "ui://widget/gptwork-tool-card-v5.html"`
   - `_meta.ui.resourceUri === "ui://widget/gptwork-tool-card-v5.html"`
3. **Check resource registration**: Call `resources/list` and verify v5 card is present with:
   - `uri === "ui://widget/gptwork-tool-card-v5.html"`
   - `mimeType === "text/html;profile=mcp-app"`
4. **Check resource content**: Call `resources/read` with `uri: "ui://widget/gptwork-tool-card-v5.html"` and verify it returns valid HTML with `mimeType: "text/html;profile=mcp-app"`.
5. **Verify structured content**: When calling a tool, the response should include `structuredContent` at the top level and `_meta.gptwork_card` for the card view model.
6. **ChatGPT Apps SDK support**: Ensure your ChatGPT client supports Apps SDK widget rendering. The `text/html;profile=mcp-app` mime type with the `io.modelcontextprotocol/ui` extension capability is required for card recognition.
7. **Fallback**: Even if the card doesn't render, tools should still return `content[0].text` with a readable text summary.

If all checks pass but the card still doesn't display, the issue is likely on the ChatGPT platform side (e.g., Apps SDK widget rendering not enabled for your session). In this case, the text fallback in `content[0].text` provides a readable summary.

## ChatGPT巡检修复：bounded modelPayload 契约回归

本轮巡检发现 Query/Card repair 任务虽然已有 branch-pushed commit 和局部测试证据，但当前 main 上 `runtime_status`、`get_task`、`create_task` 的模型可见 `structuredContent` 重新暴露了 `worker`/`queue`/`task`/`goal` 对象，违反 v5 card 的 bounded modelPayload 契约。

修复原则：

- `modelPayload` 只保留 ChatGPT 推进任务所需的浅层 id、状态、标题和标量诊断字段。
- 原始或近似原始的 `worker`、`queue`、`task`、`goal` 对象只允许进入 card view/_meta，不进入模型可见 payload。
- `runtime_status` 如需给 ChatGPT 判断队列和 worker，只暴露 `worker_enabled`、`worker_running`、`worker_health`、`queue_*` 这类 bounded scalar 字段。

验证命令：

```bash
cd backend && node --test --test-reporter=dot   test/tool-result.test.mjs   test/card-payload-contract.test.mjs   test/card-view-model.test.mjs   test/card-utils.test.mjs   test/apps-sdk-card-smoke.test.mjs
cd backend && find src -name '*.mjs' -type f -print0 | sort -z | xargs -0 -r -n 1 -P 8 node --check
```

预期结果：card/query 契约测试全通过，源码语法检查通过。

