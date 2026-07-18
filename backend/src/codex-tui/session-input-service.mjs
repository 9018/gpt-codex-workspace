/**
 * session-input-service.mjs — Send input and task deltas to a live TUI session.
 *
 * @module session-input-service
 */

import { createTaskContextStore } from "../context-contract/task-context-store.mjs";
import { validateTaskDelta, renderDeltaInstruction } from "../codex-tui-task-delta.mjs";
import { activeManagerForSession } from "./active-session-registry.mjs";
import { findStoreForSession } from "./session-bootstrap.mjs";
import { submitTuiText } from "./tui-safe-input.mjs";

export async function sendCodexTuiSessionInput(sessionId, text, options = {}) {
  await findStoreForSession(sessionId, options);
  const { store, ptySession } = activeManagerForSession(sessionId);
  ptySession.write(text);
  await store.appendSessionLog(sessionId, `[input] ${String(text ?? "")}`);
  return store.readSession(sessionId);
}


export async function sendCodexTuiSlashCommand(sessionId, command, options = {}) {
  const store = await findStoreForSession(sessionId, options);
  const { ptySession } = activeManagerForSession(sessionId);
  const before = await store.readSession(sessionId, { maxChars: 0 });
  const text = String(command || "").trim();
  if (!text.startsWith("/")) throw new Error("slash command must start with /");
  await submitTuiText(ptySession, text);
  await store.appendSessionLog(sessionId, `[input] ${text}\n`);
  const sleep = options.sleep_fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = Math.max(0, Number(options.ack_timeout_ms ?? 5_000));
  const deadline = Date.now() + timeoutMs;
  let current = before;
  do {
    current = await store.readSession(sessionId, { maxChars: 0 });
    if (current.last_output_at && current.last_output_at !== before.last_output_at) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (true);
  return {
    ...current,
    command: text,
    command_submitted: true,
    ack_received: Boolean(current.last_output_at && current.last_output_at !== before.last_output_at),
    ack_status: current.last_output_at && current.last_output_at !== before.last_output_at ? "output_observed" : "timeout",
  };
}

export async function sendCodexTuiTaskDelta(sessionId, delta, options = {}) {
  const store = await findStoreForSession(sessionId, options);
  const session = await store.readSession(sessionId, { maxChars: 0 });
  const validatedDelta = validateTaskDelta(delta, session);
  const instruction = renderDeltaInstruction(validatedDelta);
  const workspaceRoot = session.metadata?.workspace_root || options.workspaceRoot;
  if (!workspaceRoot) throw new Error("workspace root unavailable for task delta");
  const contextStore = createTaskContextStore({ workspaceRoot });
  await contextStore.appendDelta(`.gptwork/goals/${session.goal_id}`, validatedDelta);
  const { autopilot, ptySession } = activeManagerForSession(sessionId);
  const sleep = options.sleep_fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  autopilot?.resetForExternalInput?.();
  if (validatedDelta.kind === "correction") {
    ptySession.write("\u001b");
    await sleep(options.interrupt_settle_ms ?? 250);
  }
  ptySession.write("\u001b[200~");
  await sendCodexTuiSessionInput(sessionId, instruction, options);
  ptySession.write("\u001b[201~");
  await sleep(options.submit_settle_ms ?? 500);
  ptySession.write("\r");
  return store.updateSession(sessionId, {
    status: "running",
    checkpoint: null,
    action_attempts: 0,
    repair_attempts: 0,
    active_delta_revision: validatedDelta.revision,
    last_delta_kind: validatedDelta.kind,
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
