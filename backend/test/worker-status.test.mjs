import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGptWorkServer } from "../src/gptwork-server.mjs";

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), "gptwork-ws-"));
  return createGptWorkServer({
    statePath: join(root, "state.json"),
    defaultWorkspaceRoot: join(root, "workspace"),
    tokens: ["test-token"],
    requireAuth: true
  });
}

async function callTool(server, name, args = {}) {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name, arguments: args }
  }, { authorization: "Bearer test-token" });

  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

// ================================================================
// worker_status tool tests
// ================================================================

test("worker_status returns enabled:false when worker has not been started", async () => {
  const server = await makeServer();
  const status = await callTool(server, "worker_status");
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
  assert.equal(status.started_at, null);
  assert.equal(typeof status.queue, "object");
  assert.equal(typeof status.queues, "object");
  assert.equal(JSON.stringify(status.queue), JSON.stringify(status.queues), "queue and queues should have same content");
});

test("worker_status returns queue counts object with all expected keys", async () => {
  const server = await makeServer();
  const status = await callTool(server, "worker_status");
  assert.ok(status.queue, "queue should be present");
  assert.ok(status.queues, "queues should be present");
  // All queue count keys should be present and numeric
  const expectedKeys = ["assigned", "queued", "running", "waiting_for_lock", "waiting_for_review", "completed", "failed"];
  // Check queue (alias) has same structure
  for (const key of expectedKeys) {
    assert.ok(key in status.queues, `queues.${key} should be present`);
    assert.equal(typeof status.queues[key], "number", `queues.${key} should be a number`);
    assert.equal(status.queues[key], 0, `queues.${key} should be 0 for fresh state`);
  }

  for (const key of expectedKeys) {
    assert.ok(key in status.queue, `queue.${key} should be present`);
    assert.equal(typeof status.queue[key], "number", `queue.${key} should be a number`);
    assert.equal(status.queue[key], 0, `queue.${key} should be 0 for fresh state`);
  }
});

test("worker_status returns expected state fields", async () => {
  const server = await makeServer();
  const status = await callTool(server, "worker_status");
  // Check all worker state fields exist
  const expectedFields = ["enabled", "running", "started_at", "last_tick_started_at",
    "last_tick_finished_at", "last_tick_duration_ms", "interval_ms", "limit",
    "concurrency", "last_tick_result", "last_error", "queue", "queues"];
  for (const field of expectedFields) {
    assert.ok(field in status, `worker_status should have ${field} field`);
  }
  // Queue should be an object
  assert.equal(typeof status.queue, "object");
});

test("worker_status does not expose secrets", async () => {
  const server = await makeServer();
  const status = await callTool(server, "worker_status");
  const str = JSON.stringify(status);
  assert.ok(!str.includes("store"), "should not expose store");
  assert.ok(!str.includes("token"), "should not expose token");
  assert.ok(!str.includes("secret"), "should not expose secret");
});
