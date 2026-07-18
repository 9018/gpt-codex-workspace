/**
 * session-input-service.mjs — Send input and task deltas to a live TUI session.
 *
 * @module session-input-service
 */

import { createTaskContextStore } from "../context-contract/task-context-store.mjs";
import { validateTaskDelta, renderDeltaInstruction } from "../codex-tui-task-delta.mjs";
import { activeManagerForSession, sessionStores } from "./active-session-registry.mjs";
import { findStoreForSession } from "./session-bootstrap.mjs";

/**
 * Send text input to a live TUI session.
 *
 * @param {string} sessionId
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<object>} Updated session record
 */
export async function sendCodexTuiSessionInput(sessionId, text, options = {}) {
  await findStoreForSession(sessionId, options);
  const { store, ptySession } = activeManagerForSession(sessionId);
  ptySession.write(text);
  await store.appendSessionLog(sessionId, `[input] ${String(text ?? "")}`);
  return store.readSession(sessionId);
}

/**
 * Send a structured task delta (instruction change) to a live TUI session.
 *
 * @param {string} sessionId
 * @param {object} delta
 * @param {object} [options]
 * @returns {Promise<object>} Updated session record
 */
export async function sendCodexTuiTaskDelta(sessionId, delta, options = {}) {
  const store = await findStoreForSession(sessionId, options);
  const session = await store.readSession(sessionId, { maxChars: 0 });
  validateTaskDelta(delta, session);
  const instruction = renderDeltaInstruction(delta);
  const workspaceRoot = session.metadata?.workspace_root || options.workspaceRoot;
  if (!workspaceRoot) throw new Error("workspace root unavailable for task delta");
  const contextStore = createTaskContextStore({ workspaceRoot });
  await contextStore.appendDelta(`.gptwork/goals/${session.goal_id}`, delta);
  const { autopilot, ptySession } = activeManagerForSession(sessionId);
  autopilot?.resetForExternalInput?.();
  if (delta.kind === "correction") {
    ptySession.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, options.interrupt_settle_ms ?? 150));
  }
  await sendCodexTuiSessionInput(sessionId, `${instruction}\r`, options);
  return store.updateSession(sessionId, {
    status: "running",
    checkpoint: null,
    action_attempts: 0,
    repair_attempts: 0,
    active_delta_revision: delta.revision,
    last_delta_kind: delta.kind,
    last_delta_at: new Date().toISOString(),
    delta_delivery: {
      delivered: true,
      input_acknowledged: true,
      model_observed: false,
      execution_started: false,
      effect_verified: false,
    },
  });
}
