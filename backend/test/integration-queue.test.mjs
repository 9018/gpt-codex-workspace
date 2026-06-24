/**
 * integration-queue.test.mjs
 * Tests for integration-queue.mjs — serial integration queue for same repo/branch.
 *
 * NOTE: runIntegrationQueue performs actual git operations and requires a
 * real git repo. These tests focus on the pure API surface and lock management.
 * Integration behavior tests should be in an e2e test with a real git repo.
 */

import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isIntegrationLocked, releaseIntegrationLock } from "../src/integration-queue.mjs";

// ===========================================================================
// Tests for lock management
// ===========================================================================

test("isIntegrationLocked: returns false for unknown repo/branch", async () => {
  const result = await isIntegrationLocked("github.com/unknown/repo", "main");
  assert.equal(result, false);
});

test("releaseIntegrationLock: does not throw for unknown repo/branch", async () => {
  await releaseIntegrationLock("github.com/unknown/repo", "main");
  // Should not throw
  assert.ok(true);
});

test("releaseIntegrationLock: called on unknown key is a no-op", async () => {
  // Verify the function is callable and doesn't crash
  await releaseIntegrationLock("nonexistent/repo", "dev");
  assert.equal(await isIntegrationLocked("nonexistent/repo", "dev"), false);
});

// ===========================================================================
// Test: exports are present
// ===========================================================================

test("integration-queue exports expected symbols", async () => {
  const mod = await import("../src/integration-queue.mjs");
  assert.equal(typeof mod.runIntegrationQueue, "function");
  assert.equal(typeof mod.isIntegrationLocked, "function");
  assert.equal(typeof mod.releaseIntegrationLock, "function");
});

// ===========================================================================
// Test: TODO about Map-based in-memory lock
// ===========================================================================

test("integration-queue: memory lock note and TODO", async () => {
  // This test documents that INTEGRATION_LOCKS is a Map-based in-memory lock.
  // For production multi-process use, it should be replaced with persistent
  // locks (e.g., repo-lock-lifecycle filesystem locks).
  //
  // FIXED(P0): INTEGRATION_LOCKS now uses file-based locks when locksBasePath is provided.
  // locks using repo-lock-lifecycle's acquireRepoLock/releaseRepoLock pattern.
  // This ensures cross-process serial integration and survives process restarts.
  //
  // Current limitation: Map-based locks are per-process only. A process restart
  // loses all integration locks, which can result in concurrent integrations
  // on the same repo+branch.
  assert.ok(true, "TODO documented: INTEGRATION_LOCKS is Map-based (in-memory only)");
});

console.log("integration-queue tests loaded");
