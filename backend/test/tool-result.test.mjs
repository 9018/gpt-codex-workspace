/**
 * tool-result.test.mjs — Unit tests for tagToolResult / generateAutoSummary
 *
 * Tests auto-summary generation, status detection, payload hashing,
 * and edge cases for the Apps SDK card tool result tagging.
 */
import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tagToolResult, shapeToolResult, payloadHash } from "../src/apps-sdk-card/tool-result.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyDescriptor = { metadata: {} };

/** Helper to run tagToolResult with a tool name and optional name in descriptor. */
function tag(name, payload, descriptor) {
  return tagToolResult(name, descriptor || emptyDescriptor, payload).modelPayload;
}

// ---------------------------------------------------------------------------
// Summary auto-generation
// ---------------------------------------------------------------------------

test("tagToolResult: generates summary from self-test results array", () => {
  const res = tag("gptwork_self_test", {
    results: [
      { id: "1", name: "check1", status: "PASS" },
      { id: "2", name: "check2", status: "PASS" },
      { id: "3", name: "check3", status: "PASS" },
      { id: "4", name: "check4", status: "PASS" },
      { id: "5", name: "check5", status: "PASS" },
      { id: "6", name: "check6", status: "PASS" },
      { id: "7", name: "check7", status: "PASS" },
      { id: "8", name: "check8", status: "PASS" },
      { id: "9", name: "check9", status: "PASS" },
      { id: "10", name: "check10", status: "PASS" },
      { id: "11", name: "check11", status: "PASS" },
      { id: "12", name: "check12", status: "PASS" },
    ],
  });
  assert.equal(res.summary, "gptwork_self_test: 12 PASS");
  assert.equal(res.status, "info");
  assert.equal(res.gptwork_type, "tool_result");
  assert.ok(res.gptwork_card_instance_id.startsWith("gptwork_self_test:"));
});

test("tagToolResult: self-test results with mixed statuses", () => {
  const res = tag("gptwork_self_test", {
    results: [
      { id: "1", status: "PASS" },
      { id: "2", status: "WARN" },
      { id: "3", status: "FAIL" },
    ],
  });
  assert.equal(res.summary, "gptwork_self_test: 1 PASS, 1 WARN, 1 FAIL");
});

test("tagToolResult: preserves explicit summary when present", () => {
  const res = tag("runtime_status", {
    summary: "Custom runtime summary",
    status: "ok",
    commit: "abc123",
  });
  assert.equal(res.summary, "Custom runtime summary");
  assert.equal(res.status, "ok");
});

test("tagToolResult: preserves explicit status when present", () => {
  const res = tag("worker_status", {
    status: "running",
    tasks: 3,
  });
  assert.equal(res.status, "running");
  // summary should be auto-generated since none provided
  assert.ok(res.summary.includes("tasks: 3"), `unexpected summary: ${res.summary}`);
});

test("tagToolResult: empty results array", () => {
  const res = tag("gptwork_self_test", {
    results: [],
  });
  assert.equal(res.summary, "gptwork_self_test: 1 fields"); // fallback: only key is "results", zero PASS items
});

// ---------------------------------------------------------------------------
// Status auto-detection
// ---------------------------------------------------------------------------

test("tagToolResult: auto status from ok: true", () => {
  const res = tag("health_check", { ok: true });
  assert.equal(res.status, "ok");
});

test("tagToolResult: auto status from ok: false", () => {
  const res = tag("health_check", { ok: false });
  assert.equal(res.status, "error");
});

test("tagToolResult: auto status from errors array", () => {
  const res = tag("some_tool", { errors: ["err1", "err2"] });
  assert.equal(res.status, "error");
});

test("tagToolResult: auto status from crashed flag", () => {
  const res = tag("some_tool", { crashed: true });
  assert.equal(res.status, "error");
});

test("tagToolResult: auto status info fallback", () => {
  const res = tag("empty_tool", {});
  assert.equal(res.status, "info");
});

// ---------------------------------------------------------------------------
// Count-based summary patterns
// ---------------------------------------------------------------------------

test("tagToolResult: count-based summary for tasks/goals/items", () => {
  const res = tag("task_manager", { tasks: 5, goals: 3, items: ["a", "b"] });
  assert.ok(res.summary.includes("tasks: 5"), `summary: ${res.summary}`);
  assert.ok(res.summary.includes("goals: 3"), `summary: ${res.summary}`);
  assert.ok(res.summary.includes("items: 2"), `summary: ${res.summary}`);
});

test("tagToolResult: count-based summary with active and queue", () => {
  const res = tag("queue_view", { active: 1, queue: ["q1", "q2", "q3"] });
  assert.ok(res.summary.includes("queue: present"));
});

// ---------------------------------------------------------------------------
// Non-object payloads
// ---------------------------------------------------------------------------

test("tagToolResult: wraps array payloads", () => {
  const res = tag("list_tasks", ["task1", "task2"]);
  assert.equal(res.gptwork_type, "tool_result");
  assert.equal(res.rawAvailable, true);
  assert.equal(res.value, undefined);
  assert.ok(typeof res.gptwork_tool === "string");
});

test("tagToolResult: wraps string payloads", () => {
  const res = tag("echo", "hello world");
  // modelPayload is bounded — raw value is not propagated
  assert.equal(res.value, undefined);
  assert.equal(res.rawAvailable, true);
  assert.ok(res.summary !== undefined, "string payload should still have summary");
  assert.equal(res.gptwork_title, "echo");
});

test("tagToolResult: wraps null payloads", () => {
  const res = tag("returns_null", null);
  assert.equal(res.value, undefined);
  assert.equal(res.rawAvailable, true);
  assert.equal(res.gptwork_tool, "returns_null");
});

test("tagToolResult: wraps undefined/empty payloads", () => {
  const res = tag("returns_undefined", undefined);
  // When structuredContent is undefined, tool-result wraps it properly
  assert.ok(res.gptwork_type === "tool_result" || res.gptwork_type === undefined);
});

// ---------------------------------------------------------------------------
// Payload hash
// ---------------------------------------------------------------------------

test("tagToolResult: payload hash is stable for same input", () => {
  const input = { ok: true, commit: "abc123", mode: "standard" };
  const res1 = tag("runtime_status", input);
  const res2 = tag("runtime_status", input);
  assert.equal(res1.gptwork_payload_hash, res2.gptwork_payload_hash);
});

test("payloadHash: volatile keys excluded", () => {
  const h1 = payloadHash({ ok: true, current_time: "2024-01-01T00:00:00Z" });
  const h2 = payloadHash({ ok: true, current_time: "2024-06-01T00:00:00Z" });
  assert.equal(h1, h2, "volatile keys must not affect hash");
});

test("payloadHash: gptwork_ prefixed keys excluded", () => {
  const h1 = payloadHash({ ok: true });
  const h2 = payloadHash({ ok: true, gptwork_tool: "runtime_status" });
  assert.equal(h1, h2, "gptwork_ prefixed keys must not affect hash");
});

test("payloadHash: different payloads produce different hashes", () => {
  const h1 = payloadHash({ ok: true });
  const h2 = payloadHash({ ok: false });
  assert.notEqual(h1, h2);
});

// ---------------------------------------------------------------------------
// toolDescriptor metadata integration
// ---------------------------------------------------------------------------

test("tagToolResult: title from toolDescriptor.metadata.name", () => {
  const res = tag("runtime_status", { ok: true }, {
    metadata: { name: "Runtime Status" },
  });
  assert.equal(res.gptwork_title, "Runtime Status");
});

test("tagToolResult: fallback title to tool name when no metadata", () => {
  const res = tag("runtime_status", { ok: true }, emptyDescriptor);
  assert.equal(res.gptwork_title, "runtime_status");
});

test("tagToolResult: gptwork_card_instance_id includes name and hash", () => {
  const res = tag("gptwork_self_test", { results: [] });
  assert.ok(res.gptwork_card_instance_id.startsWith("gptwork_self_test:"));
  assert.ok(res.gptwork_card_instance_id.length > "gptwork_self_test:".length);
});

// ---------------------------------------------------------------------------
// shapeToolResult integration
// ---------------------------------------------------------------------------

test("shapeToolResult: produces valid structuredContent and text fallback", () => {
  const result = shapeToolResult({
    name: "health_check",
    toolDescriptor: emptyDescriptor,
    rawStructuredContent: { ok: true, service: "gptwork-mcp" },
    summarizeToolResult: undefined,
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.ok, true, "structuredContent must contain original data");
  assert.equal(result.structuredContent?.service, "gptwork-mcp");
  assert.ok(typeof result.content?.[0]?.text === "string");
  assert.ok(result.content[0].text.length > 0, "text summary must not be empty");
});

test("shapeToolResult: with card metadata returns _meta", () => {
  const result = shapeToolResult({
    name: "health_check",
    toolDescriptor: {
      metadata: {
        outputTemplate: "ui://widget/gptwork-card-v2.html",
      },
    },
    rawStructuredContent: { ok: true },
    summarizeToolResult: undefined,
  });
  assert.ok(result._meta !== undefined, "should have _meta when card metadata present");
  assert.ok(result._meta.resourceUri, "ui://widget/gptwork-tool-card-v5.html");
  assert.equal(result._meta.tool, "health_check");
});

test("shapeToolResult: card-enabled runtime_status injects unified card and legacy fields", () => {
  const result = shapeToolResult({
    name: "runtime_status",
    toolDescriptor: {
      metadata: {
        outputTemplate: "ui://widget/gptwork-card-v2.html",
        name: "Runtime Status",
      },
    },
    rawStructuredContent: {
      pid: 123,
      worktree_dirty: false,
      running_commit: "abcdef1234567890",
      worker: { enabled: true, running: true, health: { phase: "healthy" }, queue: { assigned: 1 } },
      queue: { assigned: 1, running: 0, waiting_for_review: 0, failed: 0 },
    },
    summarizeToolResult: undefined,
  });

  assert.equal(result.structuredContent.card?.card_version, "gptwork-card-v1");
  assert.equal(result.structuredContent.card?.card_type, "runtime_health");
  assert.equal(result.structuredContent.card?.identity?.tool, "runtime_status");
  assert.equal(result.structuredContent.summary, result.structuredContent.card.summary);
  assert.equal(result.structuredContent.status, result.structuredContent.card.status);
  assert.ok(Array.isArray(result.structuredContent.keyValues), "legacy keyValues must be available");
  assert.ok(Array.isArray(result.structuredContent.items), "legacy items must be available");
  assert.match(result.content[0].text, /Runtime Status/);
  assert.match(result.content[0].text, /queue.assigned/);
});

test("shapeToolResult: without card metadata no _meta", () => {
  const result = shapeToolResult({
    name: "no_card_tool",
    toolDescriptor: emptyDescriptor,
    rawStructuredContent: { ok: true },
    summarizeToolResult: undefined,
  });
  assert.equal(result._meta, undefined, "should NOT have _meta when no card metadata");
});

test("shapeToolResult: custom summarizeToolResult is used", () => {
  const customSummary = "CUSTOM SUMMARY";
  const result = shapeToolResult({
    name: "custom_tool",
    toolDescriptor: emptyDescriptor,
    rawStructuredContent: { key: "value" },
    summarizeToolResult: () => customSummary,
  });
  assert.equal(result.content[0].text, customSummary);
});

// ---------------------------------------------------------------------------
// Security — no raw secrets in summary
// ---------------------------------------------------------------------------

test("tagToolResult: summary does not expose raw values", () => {
  const res = tag("secret_tool", {
    api_key: "sk-abc123def456",
    password: "super-secret-password",
    token: "ghp_xYz123",
    results: [
      { id: "check1", status: "PASS" },
    ],
  });
  // Summary should only contain safe aggregate info
  assert.equal(res.summary, "secret_tool: 1 PASS");
  assert.ok(!res.summary.includes("sk-abc123"));
  assert.ok(!res.summary.includes("super-secret"));
  // Under the v5 bounded contract, raw values like api_key, password, token
  // are NOT propagated into the modelPayload. Only bounded fields are present.
  assert.equal(res.api_key, undefined);
  assert.equal(res.password, undefined);
  assert.equal(res.token, undefined);
  assert.equal(res.rawAvailable, true);
  assert.equal(res.gptwork_tool, "secret_tool");
  assert.equal(res.gptwork_type, "tool_result");
  assert.ok(Array.isArray(res.results));
});

test("tagToolResult: no large payload dumps in summary", () => {
  const largeData = [];
  for (let i = 0; i < 1000; i++) largeData.push({ id: i, value: "x".repeat(100) });
  const res = tag("big_tool", { items: largeData });
  // Summary should be concise, not contain the full data
  assert.ok(res.summary.length < 200, `summary too long: ${res.summary.length} chars`);
  assert.ok(res.summary.startsWith("big_tool"), "summary should start with tool name");
});

test("tagToolResult: gptwork_ prefixed keys propagated", () => {
  const res = tag("gptwork_self_test", { results: [{ id: "a", status: "PASS" }] });
  assert.ok(res.gptwork_tool === "gptwork_self_test");
  assert.ok(res.gptwork_type === "tool_result");
  assert.ok(typeof res.gptwork_payload_hash === "string");
  assert.ok(res.gptwork_payload_hash.length > 0);
});

test("shapeToolResult: text mode keeps bounded model data and omits all card fields", () => {
  const result = shapeToolResult({
    name: "runtime_status",
    toolDescriptor: {
      metadata: {
        outputTemplate: "ui://widget/gptwork-tool-card-v5.html",
        resourceUri: "ui://widget/gptwork-tool-card-v5.html",
        name: "Runtime Status",
      },
    },
    renderMode: "text",
    rawStructuredContent: {
      worker: { enabled: true, running: true, health: { phase: "running" } },
      queue: { assigned: 0, queued: 1, running: 0, actionable_review: 2 },
      secret_debug_blob: { token: "must-not-leak" },
    },
    summarizeToolResult: undefined,
  });

  assert.equal(result._meta, undefined);
  assert.equal(result.structuredContent.card, undefined);
  assert.equal(result.structuredContent.keyValues, undefined);
  assert.equal(result.structuredContent.items, undefined);
  assert.equal(result.structuredContent.worker, undefined);
  assert.equal(result.structuredContent.queue, undefined);
  assert.equal(result.structuredContent.secret_debug_blob, undefined);
  assert.equal(result.structuredContent.worker_running, true);
  assert.equal(result.structuredContent.queue_actionable_review, 2);
  assert.ok(result.content[0].text.length > 0);
});

test("shapeToolResult: card mode preserves v5 card envelope", () => {
  const result = shapeToolResult({
    name: "runtime_status",
    toolDescriptor: {
      metadata: {
        outputTemplate: "ui://widget/gptwork-tool-card-v5.html",
        resourceUri: "ui://widget/gptwork-tool-card-v5.html",
      },
    },
    renderMode: "card",
    rawStructuredContent: {
      worker: { enabled: true, running: true, health: { phase: "running" } },
      queue: { assigned: 0, running: 0 },
    },
    summarizeToolResult: undefined,
  });

  assert.equal(result._meta?.resourceUri, "ui://widget/gptwork-tool-card-v5.html");
  assert.equal(result._meta?.gptwork_card?.card_version, "gptwork-card-v1");
  assert.equal(result.structuredContent.card?.card_version, "gptwork-card-v1");
});
