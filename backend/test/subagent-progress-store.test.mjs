/**
 * subagent-progress-store.test.mjs — Tests for atomic progress.json/subagents.json writer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

async function makeStore() {
  const workspaceRoot = track(await mkdtemp(join(tmpdir(), "subagent-progress-")));
  const { createSubagentProgressStore } = await import("../src/subagents/subagent-progress-store.mjs");
  return { workspaceRoot, store: createSubagentProgressStore({ workspaceRoot }) };
}

const GOAL_ID = "goal_test_progress";

// ===========================================================================
// Progress write/read tests
// ===========================================================================

test("writeProgress creates progress.json with goal_id and timestamps", async () => {
  const { store } = await makeStore();

  const written = await store.writeProgress(GOAL_ID, {
    phase: "planning",
    status: "running",
    current_action: "Analyzing requirements",
  });

  assert.equal(written.goal_id, GOAL_ID);
  assert.equal(written.phase, "planning");
  assert.equal(written.status, "running");
  assert.equal(written.current_action, "Analyzing requirements");
  assert.ok(written.last_progress_at);
  assert.ok(Array.isArray(written.subagents));
});

test("writeProgress merges with existing progress", async () => {
  const { store } = await makeStore();

  await store.writeProgress(GOAL_ID, {
    phase: "context_curation",
    status: "running",
    current_action: "Gathering context",
  });

  const second = await store.writeProgress(GOAL_ID, {
    status: "completed",
    current_action: "Context ready",
  });

  assert.equal(second.phase, "context_curation"); // preserved from first
  assert.equal(second.status, "completed"); // updated
  assert.equal(second.current_action, "Context ready"); // updated
});

test("readProgress returns null for non-existent goal", async () => {
  const { store } = await makeStore();
  const result = await store.readProgress("goal_nonexistent");
  assert.equal(result, null);
});

test("writeProgress normalizes invalid status to declared", async () => {
  const { store } = await makeStore();

  const written = await store.writeProgress(GOAL_ID, {
    status: "invalid_status",
  });

  assert.equal(written.status, "declared");
});

// ===========================================================================
// Subagents write/read tests
// ===========================================================================

test("writeSubagents creates subagents.json", async () => {
  const { store } = await makeStore();

  const written = await store.writeSubagents(GOAL_ID, [
    { role: "explorer", status: "completed", summary: "Found the API", changed_files: ["api.ts"], artifacts: ["report.md"] },
    { role: "architect", status: "completed", summary: "Designed the schema", changed_files: ["schema.sql"], artifacts: [] },
  ]);

  assert.equal(written.length, 2);
  assert.equal(written[0].role, "explorer");
  assert.equal(written[0].status, "completed");
  assert.equal(written[0].summary, "Found the API");
  assert.deepEqual(written[0].changed_files, ["api.ts"]);
  assert.deepEqual(written[0].artifacts, ["report.md"]);
  assert.ok(written[0].started_at === null);
});

test("writeSubagents merges by role+round", async () => {
  const { store } = await makeStore();

  await store.writeSubagents(GOAL_ID, [
    { role: "builder", round: 1, status: "running", summary: "Building" },
  ]);

  const written = await store.writeSubagents(GOAL_ID, [
    { role: "builder", round: 1, status: "completed", summary: "Done building", changed_files: ["src/main.mjs"] },
  ]);

  assert.equal(written.length, 1);
  assert.equal(written[0].role, "builder");
  assert.equal(written[0].status, "completed");
  assert.equal(written[0].summary, "Done building");
  assert.deepEqual(written[0].changed_files, ["src/main.mjs"]);
});

test("readSubagents returns null for non-existent goal", async () => {
  const { store } = await makeStore();
  const result = await store.readSubagents("goal_nonexistent");
  assert.equal(result, null);
});

// ===========================================================================
// appendSubagentResult tests
// ===========================================================================

test("appendSubagentResult writes both progress and subagents", async () => {
  const { store } = await makeStore();

  const result = await store.appendSubagentResult(
    GOAL_ID,
    { role: "builder", status: "completed", summary: "Built the feature" },
    { phase: "building", status: "running", current_action: "Building feature" },
  );

  assert.ok(result.progress);
  assert.ok(result.subagents);
  assert.equal(result.progress.phase, "building");
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagents[0].role, "builder");
  assert.equal(result.subagents[0].status, "completed");

  // Verify both files exist on disk
  const progressFile = join(result.progress.goal_id === GOAL_ID ? "dummy" : "dummy", "../test");
  // Just check the filesystem via the store
  const readProgressBack = await store.readProgress(GOAL_ID);
  const readSubagentsBack = await store.readSubagents(GOAL_ID);

  assert.equal(readProgressBack.phase, "building");
  assert.equal(readSubagentsBack[0].status, "completed");
});

// ===========================================================================
// buildProgressPayload tests
// ===========================================================================

test("buildProgressPayload creates proper payload with defaults", async () => {
  const { buildProgressPayload } = await import("../src/subagents/subagent-progress-store.mjs");

  const payload = buildProgressPayload();
  assert.equal(payload.phase, "context_curation");
  assert.equal(payload.status, "running");
  assert.equal(payload.current_action, "");
  assert.deepEqual(payload.blockers, []);
  assert.equal(payload.next_expected_event, "");
  assert.deepEqual(payload.subagents, []);
});

test("buildProgressPayload with custom values", async () => {
  const { buildProgressPayload } = await import("../src/subagents/subagent-progress-store.mjs");

  const payload = buildProgressPayload({
    phase: "building",
    status: "completed",
    currentAction: "Wrote code",
    blockers: ["missing_api_key"],
    nextExpectedEvent: "verification",
    subagents: [{ role: "builder", status: "completed" }],
  });

  assert.equal(payload.phase, "building");
  assert.equal(payload.status, "completed");
  assert.equal(payload.current_action, "Wrote code");
  assert.deepEqual(payload.blockers, ["missing_api_key"]);
  assert.equal(payload.next_expected_event, "verification");
  assert.equal(payload.subagents.length, 1);
});

console.log("subagent-progress-store tests loaded");
