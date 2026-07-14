import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkstreamContextStore,
} from "../src/workstream/workstream-context-store.mjs";

describe("workstream-context-store", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ws-store-"));
    store = createWorkstreamContextStore({ workspaceRoot: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSnapshot(revision = 0) {
    return {
      schema_version: "gptwork.workstream_context.v1",
      workstream_id: "ws_test",
      revision,
      digest: "",
      objective: "Test workstream",
      durable_decisions: [],
      delivered_capabilities: [],
      open_blockers: [],
      repository_state: { repo_id: "default", canonical_head: null, target_branch: "main" },
      accepted_outcomes: [],
      deprecated_facts: [],
      generated_from: [],
    };
  }

  it("returns null for non-existent snapshot", async () => {
    const snap = await store.readSnapshot("ws_nonexistent");
    assert.equal(snap, null);
  });

  it("writes and reads snapshot", async () => {
    const snap = makeSnapshot(0);
    const written = await store.writeSnapshot("ws_test", snap);
    assert.ok(written.digest.startsWith("sha256:"));
    assert.equal(written.revision, 0);

    const read = await store.readSnapshot("ws_test");
    assert.equal(read.objective, "Test workstream");
    assert.equal(read.digest, written.digest);
  });

  it("rejects write on revision conflict", async () => {
    const snap = makeSnapshot(0);
    await store.writeSnapshot("ws_test", snap);
    await assert.rejects(
      () => store.writeSnapshot("ws_test", makeSnapshot(1), { expectedRevision: 5 }),
      /revision conflict/
    );
  });

  it("increments revision", async () => {
    const v0 = makeSnapshot(0);
    await store.writeSnapshot("ws_test", v0);
    const v1 = makeSnapshot(1);
    const written = await store.writeSnapshot("ws_test", v1, { expectedRevision: 0 });
    assert.equal(written.revision, 1);
  });
});
