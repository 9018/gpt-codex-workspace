import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskContextStore, TASK_CONTEXT_JSON } from "../src/context-contract/task-context-store.mjs";
import { taskContextContractDigest } from "../src/context-contract/task-context-canonicalizer.mjs";
import { validateTaskContextPacket } from "../src/context-contract/task-context-schema.mjs";

describe("task-context-store", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let goalDir;
  /** @type {ReturnType<typeof createTaskContextStore>} */
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tc-store-"));
    goalDir = ".gptwork/goals/goal_test";
    store = createTaskContextStore({ workspaceRoot: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePacket() {
    return {
      schema_version: "gptwork.task_context.v1",
      identity: { workstream_id: "ws_x", goal_id: null, task_id: null, context_revision: 1 },
      objective: "Do something",
      background: [],
      confirmed_findings: [],
      scope: { include: ["src/"], exclude: [] },
      required_changes: [],
      acceptance_criteria: [{ id: "ac1", description: "pass", blocking: true, verification_hint: null }],
      constraints: [],
      open_questions: [],
      carry_forward: [],
      source_provenance: [],
      raw_conversation_policy: { stored: true, indexed: false, injected: false, targeted_lookup_allowed: true },
    };
  }

  it("writes packet files atomically", async () => {
    const packet = makePacket();
    const digest = await store.writePacket(goalDir, packet);
    assert.ok(digest.startsWith("sha256:"));

    // Verify files exist
    const packetPath = join(tmpDir, goalDir, TASK_CONTEXT_JSON);
    const digestPath = join(tmpDir, goalDir, "task.context.digest");

    const readPacket = JSON.parse(await readFile(packetPath, "utf8"));
    assert.equal(readPacket.objective, "Do something");
    assert.equal(readPacket.schema_version, "gptwork.task_context.v1");

    const storedDigest = (await readFile(digestPath, "utf8")).trim();
    assert.equal(storedDigest, digest);
  });

  it("reads packet returns null when absent", async () => {
    const result = await store.readPacket(goalDir);
    assert.equal(result, null);
  });

  it("reads packet after write", async () => {
    const packet = makePacket();
    await store.writePacket(goalDir, packet);
    const read = await store.readPacket(goalDir);
    assert.equal(read.objective, "Do something");
  });

  it("verifyDigest passes when digest matches", async () => {
    const packet = makePacket();
    await store.writePacket(goalDir, packet);
    const ok = await store.verifyDigest(goalDir);
    assert.equal(ok, true);
  });

  it("verifyDigest throws on digest mismatch", async () => {
    const packet = makePacket();
    await store.writePacket(goalDir, packet);

    // Corrupt packet
    const packetPath = join(tmpDir, goalDir, TASK_CONTEXT_JSON);
    const corrupted = { ...packet, objective: "corrupted" };
    await writeFile(packetPath, JSON.stringify(corrupted));

    await assert.rejects(
      () => store.verifyDigest(goalDir),
      /task_context_digest_mismatch/
    );
  });

  it("writes and reads deltas", async () => {
    await store.appendDelta(goalDir, { kind: "new_evidence", revision: 1, task_id: null, goal_id: null });
    await store.appendDelta(goalDir, { kind: "review_findings", revision: 2, task_id: null, goal_id: null });

    const deltas = await store.readDeltas(goalDir);
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].kind, "new_evidence");
    assert.equal(deltas[1].kind, "review_findings");
  });

  it("writes provenance when provided", async () => {
    const packet = makePacket();
    const prov = [
      { kind: "chatgpt_conversation", uri: "chatgpt-conversation://abc", relation: "originates" },
    ];
    await store.writePacket(goalDir, packet, { sourceProvenance: prov });

    const provPath = join(tmpDir, goalDir, "source.provenance.json");
    const readProv = JSON.parse(await readFile(provPath, "utf8"));
    assert.equal(readProv.length, 1);
    assert.equal(readProv[0].kind, "chatgpt_conversation");
  });
});
