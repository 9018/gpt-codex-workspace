# GPTWork Text Render Mode Design

Date: 2026-07-11
Status: Approved direction — implementation pending

## Purpose

Replace the default GPTWork Apps SDK v5 card rendering path with a text-first result path so ChatGPT mobile clients do not create an embedded HTML widget for every tool call. The goal is to reduce scrolling jank, memory pressure, CPU/GPU work, battery drain, and device heat in long conversations while preserving the model-facing data needed to continue work reliably.

## Decision

GPTWork will support a render-mode setting with `text` as the default and selected mode for the current deployment.

```text
GPTWORK_RENDER_MODE=text
```

Supported values:

- `text`: no Apps SDK widget metadata or widget resource exposure; return readable text plus bounded `structuredContent`.
- `selective`: reserved compatibility mode in which only an explicit allowlist of low-frequency, high-value tools may advertise the widget.
- `card`: retain the existing v5 card behavior for desktop demonstrations and compatibility testing.

The initial implementation must fully support `text` and preserve `card`. `selective` may be implemented as a small allowlist using the same mode switch, but it must not expand scope or block delivery of `text`.

## Current Problem

The current server advertises `ui://widget/gptwork-tool-card-v5.html` on many high-frequency tools through both `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]`. Tool results also carry a card view model in `_meta.gptwork_card` and a compatibility copy in `structuredContent.card`.

Although the widget source is only about 24.5 KB, each rendered tool card can require an embedded Apps SDK HTML execution and layout context. In long mobile conversations, many independent widget instances can accumulate. Reducing CSS or HTML size alone does not remove that per-instance rendering cost.

## Architecture

### Runtime configuration

Add a normalized render-mode value to GPTWork runtime configuration:

```text
text | selective | card
```

Resolution order should follow existing configuration conventions, using an explicit runtime option if one already exists for comparable settings, then `GPTWORK_RENDER_MODE`, then the default `text`.

Unknown values must fail fast with a clear configuration error rather than silently enabling cards.

### Tool descriptor metadata

Create one mode-aware metadata function instead of attaching card metadata unconditionally.

Behavior:

- `text`: tool descriptors omit `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]`.
- `selective`: only tools in a central allowlist receive the existing card metadata.
- `card`: preserve the existing descriptor metadata exactly.

High-frequency status and listing tools must not be in the selective allowlist. Candidate selective tools are limited to final review or change-inspection results such as `show_changes` and terminal task completion summaries.

### Resource and capability registration

Behavior:

- `text`: do not advertise the Apps SDK UI extension and do not register or list the v5 widget resource.
- `selective` and `card`: register the existing v5 resource and required UI capability.

Legacy widget aliases may remain available only when a widget-capable mode is active.

### Tool result contract

In `text` mode, every affected tool result must continue to return:

1. `content[0].text`: concise, readable output suitable for direct display in ChatGPT.
2. `structuredContent`: bounded model-facing fields required for reasoning, task continuation, IDs, statuses, counts, and next actions.
3. `isError` where currently applicable.

In `text` mode, results must omit:

- `_meta.resourceUri`
- `_meta.gptwork_card`
- `structuredContent.card`
- other widget-only state and identity fields that have no model-facing purpose

The text path must not expose raw task objects, raw queues, complete stdout/stderr, full diffs, secrets, or debug blobs. Existing deep-inspection tools remain the only path to detailed evidence.

In `card` mode, the existing three-layer contract remains unchanged.

### Text formatting

Text output should use a compact, consistent structure:

```text
Worker running · 0 active · 3 need review

Worker: enabled / healthy
Queue: 0 assigned, 0 running, 3 actionable review
Next: review pending task results
```

Formatting rules:

- First line: one-sentence result summary.
- Optional following lines: only high-value scalar fields and next action.
- No large Markdown tables for routine status tools.
- Bound all lists and excerpts using existing limits.
- Preserve identifiers needed for follow-up calls.

## Components and Boundaries

### Render-mode configuration module

Responsibility: parse and expose the normalized render mode.

Dependencies: existing runtime/environment configuration only.

### Card metadata module

Responsibility: determine whether a specific tool should receive widget descriptor metadata.

Interface concept:

```js
toolCardMeta({ renderMode, toolName })
```

It returns the existing metadata object or no metadata.

### Tool result builder

Responsibility: build mode-appropriate result envelopes without weakening bounded payload rules.

It should delegate card view-model construction only for widget-capable modes. Text content generation must remain usable independently of the card renderer.

### Server registration

Responsibility: conditionally advertise UI capabilities and register widget resources based on render mode.

It must not contain per-tool formatting logic.

## Error Handling

- Invalid `GPTWORK_RENDER_MODE`: startup/configuration error naming the accepted values.
- Missing text summary: use the existing safe fallback summary, never an empty result.
- Widget-capable mode with failed resource load: preserve the current readable `content[0].text` fallback.
- `text` mode must not fail merely because widget source files are absent or unreadable at runtime.

## Compatibility

- Existing users may restore the current experience with `GPTWORK_RENDER_MODE=card`.
- Existing v5 widget HTML and card schema remain intact for card mode.
- MCP tool names, arguments, write behavior, queue behavior, and task semantics do not change.
- ChatGPT connectors cache tool descriptors; after deployment, users must refresh/reconnect the GPTWork app for text mode to take effect in new calls.
- Existing cards already present in old conversation messages will not be retroactively converted to text.

## Testing

Add or update tests for all three contract areas.

### Configuration tests

- Default is `text`.
- `text`, `selective`, and `card` parse successfully.
- Unknown values fail with a useful error.

### Descriptor and resource tests

For `text` mode:

- tools do not expose `openai/outputTemplate` or `ui.resourceUri`.
- UI extension capability is absent.
- widget resource is not listed or readable through the normal resource registry.

For `card` mode:

- existing v5 descriptor, capability, resource, and legacy-alias tests continue to pass.

For `selective` mode:

- allowlisted tools have metadata.
- high-frequency tools such as `runtime_status`, `worker_status`, `list_tasks`, `list_goals`, and `list_goal_queue` do not.

### Result contract tests

For `text` mode:

- `content[0].text` is present and readable.
- bounded operational fields remain available in `structuredContent`.
- `_meta.gptwork_card`, `_meta.resourceUri`, and `structuredContent.card` are absent.
- raw worker, queue, task, goal, stdout, stderr, and full diff payloads remain excluded.

For `card` mode:

- existing card payload contract remains unchanged.

### Regression verification

Run focused card/result tests, full backend tests if practical, syntax checks, and tool-exposure verification. Verify both `GPTWORK_RENDER_MODE=text` and `GPTWORK_RENDER_MODE=card` server initialization paths.

## Deployment

1. Implement and verify the mode switch.
2. Set the current service environment to `GPTWORK_RENDER_MODE=text`.
3. Restart GPTWork using the existing managed restart path.
4. Verify runtime health and tool exposure.
5. Refresh/reconnect the ChatGPT app so cached descriptors are replaced.
6. Confirm a new `worker_status` or `runtime_status` call appears as native text without an embedded card.

## Acceptance Criteria

- New tool calls in the current deployment render as native ChatGPT text with no Apps SDK card.
- Mobile users can scroll long GPTWork conversations without accumulating new widget instances.
- ChatGPT retains enough bounded structured data to create, inspect, assign, and review tasks.
- No raw evidence or sensitive payload is introduced into `structuredContent`.
- `GPTWORK_RENDER_MODE=card` restores the existing v5 behavior without functional regression.
- Tests cover configuration, descriptor exposure, resource registration, and result-envelope differences between modes.

## Non-Goals

- Removing the v5 widget source entirely.
- Redesigning GPTWork task, queue, goal, or worker semantics.
- Changing ChatGPT client behavior for cards already rendered in historical messages.
- Building a separate mobile web frontend.
- Adding new interactive controls to text responses.
