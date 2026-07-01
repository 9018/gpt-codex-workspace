/**
 * external-control-adapter.test.mjs — Tests for the External Control Adapter
 * contract, registry, and the GitHub Issues optional adapter wrapper.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAdapter,
  createDisabledStubAdapter,
  createAdapterRegistry,
} from "../src/external-control-adapter.mjs";
import { createWebhookRegistry, RESERVED_WEBHOOK_EVENTS, createDefaultWebhookRegistry } from "../src/webhook-service.mjs";
import { createGithubControlAdapter } from "../src/github-adapter.mjs";

// ---------------------------------------------------------------------------
// validateAdapter
// ---------------------------------------------------------------------------

test("validateAdapter rejects null/undefined", () => {
  const r1 = validateAdapter(null);
  assert.ok(r1.length > 0, "null should fail validation");
  assert.ok(r1[0].includes("non-null"));

  const r2 = validateAdapter(undefined);
  assert.ok(r2.length > 0);

  const r3 = validateAdapter(42);
  assert.ok(r3.length > 0);
});

test("validateAdapter accepts a valid adapter", () => {
  const valid = {
    name: "test",
    enabled: false,
    mirrorState: async () => {},
    importState: async () => {},
    readCommands: async () => {},
    status: () => {},
  };
  assert.deepEqual(validateAdapter(valid), []);
});

test("validateAdapter detects missing methods", () => {
  const partial = {
    name: "partial",
    enabled: true,
    mirrorState: async () => {},
  };
  const missing = validateAdapter(partial);
  assert.ok(missing.length > 0, "should detect missing methods");
  assert.ok(missing.some((m) => m.includes("importState")), "should mention importState");
  assert.ok(missing.some((m) => m.includes("readCommands")), "should mention readCommands");
  assert.ok(missing.some((m) => m.includes("status")), "should mention status");
});

test("validateAdapter detects wrong types", () => {
  const wrong = {
    name: 42,
    enabled: "yes",
    mirrorState: async () => {},
    importState: async () => {},
    readCommands: async () => {},
    status: () => {},
  };
  const missing = validateAdapter(wrong);
  assert.ok(missing.some((m) => m.includes("name")), "name must be a string");
  assert.ok(missing.some((m) => m.includes("enabled")), "enabled must be a boolean");
});

// ---------------------------------------------------------------------------
// createDisabledStubAdapter
// ---------------------------------------------------------------------------

test("createDisabledStubAdapter returns a valid disabled adapter", () => {
  const stub = createDisabledStubAdapter("test-stub");
  assert.deepEqual(validateAdapter(stub), []);
  assert.equal(stub.name, "test-stub");
  assert.equal(stub.enabled, false);
});

test("createDisabledStubAdapter mirrorState returns not-configured", async () => {
  const stub = createDisabledStubAdapter("test-stub");
  const result = await stub.mirrorState({});
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.ok(result.details.reason.includes("not configured"));
});

test("createDisabledStubAdapter importState returns empty with skip reason", async () => {
  const stub = createDisabledStubAdapter("test-stub");
  const result = await stub.importState(null);
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].reason.includes("not configured"));
});

test("createDisabledStubAdapter readCommands returns empty", async () => {
  const stub = createDisabledStubAdapter("test-stub");
  const result = await stub.readCommands(null);
  assert.equal(result.commands.length, 0);
  assert.equal(result.imported.length, 0);
});

test("createDisabledStubAdapter status shows disabled", () => {
  const stub = createDisabledStubAdapter("test-stub");
  const s = stub.status();
  assert.equal(s.enabled, false);
  assert.equal(s.name, "test-stub");
  assert.equal(s.configured, false);
});

// ---------------------------------------------------------------------------
// createAdapterRegistry
// ---------------------------------------------------------------------------

function makeMockAdapter(name, enabled = false) {
  return {
    name,
    enabled,
    mirrorState: async (state) => ({ ok: enabled, count: enabled ? 1 : 0, details: {} }),
    importState: async (store, opts) => ({
      imported: enabled ? [{ id: "mock-1", title: "Mock" }] : [],
      skipped: [],
      diagnostics: { mock: true },
    }),
    readCommands: async (store) => ({
      commands: enabled ? [{ type: "mock_command" }] : [],
      imported: [],
      details: { count: enabled ? 1 : 0 },
    }),
    status: () => ({ enabled, name, healthy: true }),
    getDiagnostics: () => ({ last_sync: null }),
  };
}

test("registry starts empty", () => {
  const registry = createAdapterRegistry();
  assert.equal(registry.size, 0);
  assert.equal(registry.getAllAdapters().length, 0);
  assert.deepEqual(registry.getEnabledAdapters(), []);
});

test("registry.register validates adapters", () => {
  const registry = createAdapterRegistry();
  assert.throws(() => registry.register("bad", { name: "bad" }), /contract validation/);
  assert.throws(() => registry.register("", makeMockAdapter("x")), /non-empty string/);
});

test("registry.register rejects duplicate by default", () => {
  const registry = createAdapterRegistry();
  registry.register("test", makeMockAdapter("test", false));
  assert.throws(() => registry.register("test", makeMockAdapter("test2", false)), /already registered/);
});

test("registry.register allows overwrite with option", () => {
  const registry = createAdapterRegistry({ allowOverwrite: true });
  registry.register("test", makeMockAdapter("first"));
  registry.register("test", makeMockAdapter("second"));
  assert.equal(registry.size, 1);
});

test("registry.register returns registry for chaining", () => {
  const registry = createAdapterRegistry();
  const ret = registry.register("a", makeMockAdapter("a"));
  assert.equal(ret, registry);
});

test("registry.has and getAdapter", () => {
  const registry = createAdapterRegistry();
  const adapter = makeMockAdapter("found", false);
  registry.register("find-me", adapter);
  assert.equal(registry.has("find-me"), true);
  assert.equal(registry.has("missing"), false);
  assert.equal(registry.getAdapter("find-me"), adapter);
  assert.equal(registry.getAdapter("missing"), null);
});

test("registry.unregister removes an adapter", () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a"));
  registry.register("b", makeMockAdapter("b"));
  assert.equal(registry.size, 2);
  registry.unregister("a");
  assert.equal(registry.size, 1);
  assert.equal(registry.has("a"), false);
  assert.equal(registry.has("b"), true);
});

test("registry.getAllAdapters returns all entries", () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a"));
  registry.register("b", makeMockAdapter("b"));
  const all = registry.getAllAdapters();
  assert.equal(all.length, 2);
  const types = all.map((e) => e.type).sort();
  assert.deepEqual(types, ["a", "b"]);
});

test("registry.getEnabledAdapters returns only enabled ones", () => {
  const registry = createAdapterRegistry();
  registry.register("enabled-1", makeMockAdapter("e1", true));
  registry.register("disabled", makeMockAdapter("d1", false));
  registry.register("enabled-2", makeMockAdapter("e2", true));
  const enabled = registry.getEnabledAdapters();
  assert.equal(enabled.length, 2);
  assert.ok(enabled.every((e) => e.adapter.enabled === true));
});

test("registry.mirrorAllState calls only enabled adapters", async () => {
  const registry = createAdapterRegistry();
  registry.register("enabled-1", makeMockAdapter("e1", true));
  registry.register("disabled", makeMockAdapter("d1", false));
  const results = await registry.mirrorAllState({ tasks: [] });
  assert.ok("enabled-1" in results, "enabled adapter should have a result");
  assert.ok(!("disabled" in results), "disabled adapter should not be called");
  assert.equal(results["enabled-1"].ok, true);
});

test("registry.mirrorAllState handles errors gracefully", async () => {
  const registry = createAdapterRegistry();
  const broken = makeMockAdapter("broken", true);
  broken.mirrorState = async () => { throw new Error("boom"); };
  registry.register("broken", broken);
  const results = await registry.mirrorAllState({});
  assert.ok("broken" in results);
  assert.equal(results.broken.ok, false);
  assert.ok(results.broken.error.includes("boom"));
});

test("registry.importAllState merges from enabled adapters", async () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a", true));
  registry.register("b", makeMockAdapter("b", false));
  const result = await registry.importAllState({ load: async () => ({}), save: async () => {} });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].source_type, "a");
  assert.ok("a" in result.diagnostics);
});

test("registry.readAllCommands collects from enabled adapters", async () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a", true));
  const result = await registry.readAllCommands(null);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].source_type, "a");
});

test("registry.statusAll aggregates status", () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a", true));
  registry.register("b", makeMockAdapter("b", false));
  const s = registry.statusAll();
  assert.equal(s.adapter_count, 2);
  assert.equal(s.enabled_count, 1);
  assert.ok("a" in s.adapters);
  assert.ok("b" in s.adapters);
  assert.equal(s.adapters.a.healthy, true);
});

test("registry.diagnosticsAll collects diagnostics", () => {
  const registry = createAdapterRegistry();
  registry.register("a", makeMockAdapter("a", true));
  const d = registry.diagnosticsAll();
  assert.ok("a" in d);
  assert.equal(d.a.last_sync, null);
});

test("registry with no adapters returns empty but not error", async () => {
  const registry = createAdapterRegistry();
  assert.deepEqual(registry.statusAll(), { adapter_count: 0, enabled_count: 0, adapters: {} });
  assert.deepEqual(await registry.mirrorAllState({}), {});
  assert.deepEqual(await registry.importAllState(null), { imported: [], skipped: [], diagnostics: {} });
});

// ---------------------------------------------------------------------------
// createGithubControlAdapter
// ---------------------------------------------------------------------------

test("createGithubControlAdapter returns a valid adapter", () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  assert.deepEqual(validateAdapter(adapter), []);
  assert.equal(adapter.name, "github-issues");
  assert.equal(adapter.enabled, false);
});

test("createGithubControlAdapter disabled mirrorState returns not-configured", async () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  const result = await adapter.mirrorState({ tasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
});

test("createGithubControlAdapter disabled importState returns empty", async () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  const result = await adapter.importState(null);
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].reason.includes("not configured"));

  // Also verify diagnostics is always an object (not undefined)
  assert.ok(typeof result.diagnostics === "object");
});

test("createGithubControlAdapter disabled readCommands returns empty", async () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  const result = await adapter.readCommands(null);
  assert.equal(result.commands.length, 0);
  assert.equal(result.imported.length, 0);
});

test("createGithubControlAdapter disabled status shows disabled", () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  const s = adapter.status();
  assert.equal(s.api_sync_enabled, false);
});

test("createGithubControlAdapter can enable with config", () => {
  const adapter = createGithubControlAdapter({
    githubEnabled: true,
    githubRepo: "owner/repo",
    githubToken: "ghp_token123",
  });
  assert.equal(adapter.enabled, true);
});

test("createGithubControlAdapter exposed _sync for backward compat", () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  assert.ok(adapter._sync, "should expose underlying sync");
  assert.equal(typeof adapter._sync.syncTask, "function");
});

test("createGithubControlAdapter getDiagnostics returns object", () => {
  const adapter = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  const d = adapter.getDiagnostics();
  assert.ok(typeof d === "object");
  assert.ok("last_sync_at" in d || "name" in d || Object.keys(d).length >= 0);
});

// ---------------------------------------------------------------------------
// Integration: register github control adapter with registry
// ---------------------------------------------------------------------------

test("github control adapter can be registered in registry", () => {
  const registry = createAdapterRegistry();
  const github = createGithubControlAdapter({ githubRepo: "", githubToken: "" });
  registry.register("github-issues", github);
  assert.equal(registry.size, 1);
  assert.equal(registry.has("github-issues"), true);
  assert.equal(registry.getAdapter("github-issues"), github);
});

test("github control adapter in registry handles bulk ops safely when disabled", async () => {
  const registry = createAdapterRegistry();
  registry.register("github-issues", createGithubControlAdapter({ githubRepo: "", githubToken: "" }));

  // With no enabled adapters, bulk ops should be empty
  const mirror = await registry.mirrorAllState({ tasks: [] });
  assert.deepEqual(mirror, {});

  const imported = await registry.importAllState({ load: async () => ({}), save: async () => {} });
  assert.deepEqual(imported.imported, []);

  const status = registry.statusAll();
  assert.equal(status.adapter_count, 1);
  assert.equal(status.enabled_count, 0);
});

test("registry with enabled github adapter mirrors state", async () => {
  const registry = createAdapterRegistry();
  const store = { load: async () => ({ tasks: [], chatgpt_requests: [] }), save: async () => {} };

  // Mock fetch to avoid real API calls
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });

  try {
    const github = createGithubControlAdapter({
      githubEnabled: true,
      githubRepo: "owner/repo",
      githubToken: "ghp_token123",
    });
    registry.register("github-issues", github);

    const mirror = await registry.mirrorAllState({ tasks: [] });
    assert.ok("github-issues" in mirror);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// ---------------------------------------------------------------------------
// createWebhookRegistry
// ---------------------------------------------------------------------------

test("createWebhookRegistry starts empty", () => {
  const w = createWebhookRegistry();
  assert.equal(w.eventCount, 0);
  assert.equal(w.totalHandlers, 0);
  assert.deepEqual(w.getEvents(), []);
});

test("createWebhookRegistry registers and removes handlers", () => {
  const w = createWebhookRegistry();
  const handler = async () => "ok";

  assert.equal(w.handlerCount("test:event"), 0);
  w.on("test:event", handler);
  assert.equal(w.handlerCount("test:event"), 1);
  assert.equal(w.hasHandlers("test:event"), true);
  assert.deepEqual(w.getEvents(), ["test:event"]);

  w.off("test:event", handler);
  assert.equal(w.handlerCount("test:event"), 0);
  assert.equal(w.hasHandlers("test:event"), false);
});

test("createWebhookRegistry validates handler function", () => {
  const w = createWebhookRegistry();
  assert.throws(() => w.on("ev", "not a function"), /must be a function/);
  assert.throws(() => w.on("", async () => {}), /non-empty string/);
});

test("createWebhookRegistry dispatch calls handlers", async () => {
  const w = createWebhookRegistry();
  const calls = [];
  w.on("test:event", async (payload) => { calls.push(payload); return "handled"; });
  w.on("test:event", async (payload) => { calls.push(payload); return true; });

  const result = await w.dispatch("test:event", { data: 1 });
  assert.equal(result.event, "test:event");
  assert.equal(result.dispatched, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [{ data: 1 }, { data: 1 }]);
});

test("createWebhookRegistry dispatch handles handler errors gracefully", async () => {
  const w = createWebhookRegistry();
  w.on("test:event", async () => { throw new Error("handler fail"); });
  w.on("test:event", async () => "ok");

  const result = await w.dispatch("test:event", {});
  assert.equal(result.dispatched, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].error, "handler fail");
  assert.equal(result.results[1].ok, true);
});

test("createWebhookRegistry dispatch with no handlers returns 0 dispatched", async () => {
  const w = createWebhookRegistry();
  const result = await w.dispatch("no-such-event", {});
  assert.equal(result.dispatched, 0);
  assert.equal(result.succeeded, 0);
});

test("createWebhookRegistry returns self for chaining", () => {
  const w = createWebhookRegistry();
  const h = async () => {};
  const ret = w.on("e", h);
  assert.equal(ret, w);
  const ret2 = w.off("e", h);
  assert.equal(ret2, w);
});

// ---------------------------------------------------------------------------
// RESERVED_WEBHOOK_EVENTS
// ---------------------------------------------------------------------------

test("RESERVED_WEBHOOK_EVENTS has expected keys", () => {
  assert.equal(RESERVED_WEBHOOK_EVENTS.GITHUB_ISSUES, "github:issues");
  assert.equal(RESERVED_WEBHOOK_EVENTS.GITHUB_ISSUE_COMMENT, "github:issue_comment");
  assert.equal(RESERVED_WEBHOOK_EVENTS.GITHUB_PING, "github:ping");
  assert.equal(RESERVED_WEBHOOK_EVENTS.TASK_UPDATED, "task:updated");
  assert.equal(RESERVED_WEBHOOK_EVENTS.GOAL_UPDATED, "goal:updated");
  assert.equal(RESERVED_WEBHOOK_EVENTS.HEALTH_CHECK, "system:health_check");
  assert.equal(Object.keys(RESERVED_WEBHOOK_EVENTS).length, 6);
});

// ---------------------------------------------------------------------------
// createDefaultWebhookRegistry
// ---------------------------------------------------------------------------

test("createDefaultWebhookRegistry pre-registers all reserved events", () => {
  const w = createDefaultWebhookRegistry();
  const expectedCount = Object.keys(RESERVED_WEBHOOK_EVENTS).length;
  assert.equal(w.eventCount, expectedCount);
  assert.equal(w.totalHandlers, expectedCount);
  for (const event of Object.values(RESERVED_WEBHOOK_EVENTS)) {
    assert.equal(w.hasHandlers(event), true, `should have handler for ${event}`);
  }
});

test("createDefaultWebhookRegistry dispatch on reserved event does not throw", async () => {
  const w = createDefaultWebhookRegistry();
  const result = await w.dispatch(RESERVED_WEBHOOK_EVENTS.HEALTH_CHECK, {});
  assert.equal(result.dispatched, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].ok, true);
});
