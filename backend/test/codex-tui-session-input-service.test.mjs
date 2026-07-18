import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCodexTuiTaskDelta } from "../src/codex-tui/session-input-service.mjs";
import { activeSessions, sessionStores } from "../src/codex-tui/active-session-registry.mjs";

async function runCorrection(kind) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-delta-"));
  const sessionId = `session_delta_${kind}`;
  const writes = [];
  const patches = [];
  let resetCount = 0;
  const session = {
    id: sessionId, task_id: "task_1", goal_id: "goal_1",
    task_context_digest: "sha256:abc", active_delta_revision: 0,
    status: "waiting_for_supervisor", metadata: { workspace_root: workspaceRoot },
  };
  const store = {
    async readSession() { return { ...session }; },
    async appendSessionLog() {},
    async updateSession(_id, patch) { patches.push(patch); Object.assign(session, patch); return { ...session }; },
  };
  sessionStores.set(sessionId, store);
  activeSessions.set(sessionId, {
    store,
    ptySession: { write(text) { writes.push(text); } },
    autopilot: { resetForExternalInput() { resetCount += 1; } },
  });
  try {
    const result = await sendCodexTuiTaskDelta(sessionId, {
      kind, task_id: "task_1", goal_id: "goal_1",
      base_context_digest: "sha256:abc", revision: 1,
      instruction: "Write CORRECTED and continue.",
    }, { sleep_fn: async () => {} });
    return { result, writes, patches, resetCount };
  } finally {
    sessionStores.delete(sessionId);
    activeSessions.delete(sessionId);
  }
}

test("structured correction submits with Enter and resumes exhausted autopilot", async () => {
  const { result, writes, patches, resetCount } = await runCorrection("correction");
  assert.equal(resetCount, 1);
  assert.equal(writes.length, 5);
  assert.equal(writes[0], "\u001b");
  assert.equal(writes[1], "\u001b[200~");
  assert.match(writes[2], /Write CORRECTED and continue\./);
  assert.equal(writes[3], "\u001b[201~");
  assert.equal(writes[4], "\r");
  assert.equal(result.status, "running");
  assert.equal(result.active_delta_revision, 1);
  assert.equal(result.last_delta_kind, "correction");
  assert.equal(result.delta_delivery.delivered, true);
  assert.ok(patches.some((patch) => patch.status === "running"));
});

test("supervisor_correction uses the same active-goal correction path", async () => {
  const { result, writes } = await runCorrection("supervisor_correction");
  assert.equal(writes[0], "\u001b");
  assert.match(writes[2], /kind=correction/);
  assert.equal(result.last_delta_kind, "correction");
});
