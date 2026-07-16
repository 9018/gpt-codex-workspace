import { randomUUID } from "node:crypto";

import { buildProgressionIdempotencyKey } from "./progression-idempotency.mjs";
import { normalizeProgressionCommand } from "./progression-command-schema.mjs";
import { ProgressionCommandError, PROGRESSION_ERROR_CODES } from "./progression-errors.mjs";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureState(state) {
  state.progression_commands ||= {};
  state.progression_command_idempotency ||= {};
}

export function createProgressionCommandInState(state, input, { now, idFactory } = {}) {
  ensureState(state);
  const nowIso = now || (() => new Date().toISOString());
  const nextId = idFactory || (() => `pcmd_${randomUUID()}`);
  const normalized = normalizeProgressionCommand(input);
  const key = normalized.idempotency_key || buildProgressionIdempotencyKey(normalized);
  const existingId = state.progression_command_idempotency[key];
  const existing = existingId ? state.progression_commands[existingId] : null;
  if (existing) {
    return { created: false, idempotent_replay: true, command: clone(existing) };
  }
  const timestamp = nowIso();
  const command = {
    schema_version: 1,
    id: nextId(),
    ...normalized,
    idempotency_key: key,
    status: "pending",
    lease: null,
    attempt: 0,
    result: null,
    last_error: null,
    retry_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  state.progression_commands[command.id] = command;
  state.progression_command_idempotency[key] = command.id;
  return { created: true, idempotent_replay: false, command: clone(command) };
}

export function supersedeStaleProgressionCommandsInState(state, { taskId, decisionRevision, now } = {}) {
  ensureState(state);
  const nowIso = now || (() => new Date().toISOString());
  const superseded = [];
  const timestamp = nowIso();
  for (const command of Object.values(state.progression_commands)) {
    if (command.task_id !== taskId || !["pending", "failed"].includes(command.status)) continue;
    if (String(command.decision_revision) === String(decisionRevision)) continue;
    command.status = "superseded";
    command.result = { reason: "decision_revision_changed" };
    command.updated_at = timestamp;
    superseded.push(clone(command));
  }
  return superseded;
}

export function createProgressionCommandStore({ store, now, idFactory } = {}) {
  if (!store || typeof store.mutate !== "function") {
    throw new TypeError("store with mutate() is required");
  }
  const nowIso = now || (() => new Date().toISOString());
  const nextId = idFactory || (() => `pcmd_${randomUUID()}`);

  async function createCommand(input) {
    let result;
    await store.mutate((state) => {
      result = createProgressionCommandInState(state, input, { now: nowIso, idFactory: nextId });
    });
    return result;
  }

  async function getCommand(id) {
    if (typeof store.load !== "function") throw new TypeError("store.load() is required to read commands");
    const state = await store.load();
    ensureState(state);
    return clone(state.progression_commands[id] || null);
  }

  async function listCommands({ taskId, status } = {}) {
    if (typeof store.load !== "function") throw new TypeError("store.load() is required to read commands");
    const state = await store.load();
    ensureState(state);
    return Object.values(state.progression_commands)
      .filter((command) => !taskId || command.task_id === taskId)
      .filter((command) => !status || command.status === status)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
      .map(clone);
  }

  async function claimNextCommand({ owner, leaseMs = 60_000 } = {}) {
    if (!owner) throw new TypeError("owner is required");
    let claimed = null;
    await store.mutate((state) => {
      ensureState(state);
      const current = nowIso();
      const currentMs = timestampMs(current);
      const candidates = Object.values(state.progression_commands)
        .filter((command) => command.status === "pending"
          || (command.status === "failed"
            && command.attempt < command.max_attempts
            && (!command.retry_at || timestampMs(command.retry_at) <= currentMs)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
      const command = candidates[0];
      if (!command) return;
      command.status = "claimed";
      command.attempt += 1;
      command.lease = {
        owner,
        claimed_at: current,
        expires_at: new Date(currentMs + Math.max(1, Number(leaseMs) || 60_000)).toISOString(),
      };
      command.updated_at = current;
      claimed = clone(command);
    });
    return claimed;
  }

  async function updateClaimed({ id, owner, update }) {
    let result;
    await store.mutate((state) => {
      ensureState(state);
      const command = state.progression_commands[id];
      if (!command) throw new ProgressionCommandError(PROGRESSION_ERROR_CODES.NOT_FOUND, `Command not found: ${id}`);
      if (command.status !== "claimed" || command.lease?.owner !== owner) {
        throw new ProgressionCommandError(PROGRESSION_ERROR_CODES.LEASE_CONFLICT, `Command ${id} is not leased by ${owner}`);
      }
      update(command, nowIso());
      result = clone(command);
    });
    return result;
  }

  function markApplied({ id, owner, result = null } = {}) {
    return updateClaimed({ id, owner, update(command, timestamp) {
      command.status = "applied";
      command.result = clone(result);
      command.last_error = null;
      command.retry_at = null;
      command.lease = null;
      command.updated_at = timestamp;
    } });
  }

  function markFailed({ id, owner, error, retryAt = null } = {}) {
    return updateClaimed({ id, owner, update(command, timestamp) {
      command.status = "failed";
      command.last_error = {
        message: error?.message || String(error || "unknown progression command failure"),
        code: error?.code || null,
        at: timestamp,
      };
      command.retry_at = retryAt;
      command.lease = null;
      command.updated_at = timestamp;
    } });
  }

  function markSuperseded({ id, owner, reason } = {}) {
    return updateClaimed({ id, owner, update(command, timestamp) {
      command.status = "superseded";
      command.result = { reason: reason || "decision_revision_changed" };
      command.lease = null;
      command.updated_at = timestamp;
    } });
  }

  async function releaseExpiredLeases() {
    const recovered = [];
    await store.mutate((state) => {
      ensureState(state);
      const current = nowIso();
      const currentMs = timestampMs(current);
      for (const command of Object.values(state.progression_commands)) {
        if (command.status !== "claimed" || timestampMs(command.lease?.expires_at) > currentMs) continue;
        command.status = command.attempt >= command.max_attempts ? "failed" : "pending";
        command.last_error = {
          code: "progression_command_lease_expired",
          message: "Command lease expired before completion",
          at: current,
        };
        command.lease = null;
        command.updated_at = current;
        recovered.push(clone(command));
      }
    });
    return recovered;
  }

  async function supersedeStaleCommands({ taskId, decisionRevision } = {}) {
    let superseded = [];
    await store.mutate((state) => {
      superseded = supersedeStaleProgressionCommandsInState(state, {
        taskId,
        decisionRevision,
        now: nowIso,
      });
    });
    return superseded;
  }

  return {
    createCommand,
    getCommand,
    listCommands,
    claimNextCommand,
    markApplied,
    markFailed,
    markSuperseded,
    releaseExpiredLeases,
    supersedeStaleCommands,
  };
}
