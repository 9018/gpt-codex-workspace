import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCodexTuiTaskDelta } from "../src/codex-tui/session-input-service.mjs";
import { activeSessions, sessionStores } from "../src/codex-tui/active-session-registry.mjs";

test("structured correction submits with Enter and resumes exhausted autopilot", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tui-delta-"));
  const sessionId = "session_delta_resume";
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
  t.after(() => { sessionStores.delete(sessionId); activeSessions.delete(sessionId); });

  const result = await sendCodexTuiTaskDelta(sessionId, {
    kind: "correction", task_id: "task_1", goal_id: "goal_1",
    base_context_digest: "sha256:abc", revision: 1,
    instruction: "Write CORRECTED and continue.",
  });

  assert.equal(resetCount, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0], "\u001b");
  assert.ok(writes[1].endsWith("\r"));
  assert.match(writes[1], /Write CORRECTED and continue\./);
  assert.equal(result.status, "running");
  assert.equal(result.active_delta_revision, 1);
  assert.equal(result.delta_delivery.delivered, true);
  assert.equal(result.delta_delivery.effect_verified, false);
  assert.ok(patches.some((patch) => patch.status === "running"));
});
