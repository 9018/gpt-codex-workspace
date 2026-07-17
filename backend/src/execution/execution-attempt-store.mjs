import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ACTIVE_EXECUTION_ATTEMPT_STATES,
  createExecutionAttempt,
  validateExecutionAttempt,
} from "./execution-attempt-schema.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeId(value, name) {
  const id = String(value || "");
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${name}: ${id || "(empty)"}`);
  return id;
}

function inside(base, path) {
  const root = resolve(base);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error("attempt path escapes store");
  return target;
}

export function createExecutionAttemptStore({ workspaceRoot, now = () => new Date().toISOString() } = {}) {
  if (!workspaceRoot) throw new Error("workspaceRoot is required");
  const root = join(workspaceRoot, ".gptwork", "execution-attempts");
  const lockRoot = join(root, ".locks");

  const attemptPath = (id) => inside(root, join(root, `${safeId(id, "attempt id")}.json`));
  const taskLockPath = (taskId) => inside(lockRoot, join(lockRoot, `${safeId(taskId, "task id")}.lock`));

  async function ensure() {
    await mkdir(lockRoot, { recursive: true });
  }

  async function atomicWrite(path, value) {
    await ensure();
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }

  async function read(id) {
    return validateExecutionAttempt(JSON.parse(await readFile(attemptPath(id), "utf8")));
  }

  async function list() {
    await ensure();
    const entries = await readdir(root, { withFileTypes: true });
    const values = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try { values.push(await read(entry.name.slice(0, -5))); } catch { /* ignore invalid records */ }
    }
    return values.sort((a, b) => a.attempt_number - b.attempt_number || a.created_at.localeCompare(b.created_at));
  }

  async function withTaskLock(taskId, fn) {
    await ensure();
    const path = taskLockPath(taskId);
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`execution attempt compare-and-swap lock busy for ${taskId}`);
      throw error;
    }
    try {
      return await fn();
    } finally {
      await handle?.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
    }
  }

  async function getActiveForTask(taskId) {
    const matches = (await list()).filter((attempt) => (
      attempt.task_id === taskId && ACTIVE_EXECUTION_ATTEMPT_STATES.has(attempt.state)
    ));
    if (matches.length > 1) throw new Error(`multiple active execution attempts for task ${taskId}`);
    return matches[0] || null;
  }

  return {
    root,
    read,
    list,
    getActiveForTask,

    async claim({ taskId, goalId = null, provider, providerRevision = null, pathContext = null, inputSnapshot = null, checkpoint = null } = {}) {
      safeId(taskId, "task id");
      return withTaskLock(taskId, async () => {
        const existing = await getActiveForTask(taskId);
        if (existing) return { claimed: false, active_attempt: existing };
        const prior = (await list()).filter((attempt) => attempt.task_id === taskId);
        const attempt = createExecutionAttempt({
          taskId,
          goalId,
          provider,
          providerRevision,
          attemptNumber: Math.max(0, ...prior.map((entry) => entry.attempt_number)) + 1,
          pathContext,
          inputSnapshot,
          checkpoint,
          now: now(),
        });
        await atomicWrite(attemptPath(attempt.id), attempt);
        return { claimed: true, attempt };
      });
    },

    async transition(id, {
      expectedState,
      state,
      providerHandle,
      checkpoint,
      evidence,
      failure,
    } = {}) {
      const current = await read(id);
      return withTaskLock(current.task_id, async () => {
        const latest = await read(id);
        if (latest.state !== expectedState) {
          throw new Error(`execution attempt compare-and-swap failed: expected ${expectedState}, got ${latest.state}`);
        }
        const next = validateExecutionAttempt({
          ...latest,
          state,
          ...(providerHandle !== undefined ? { provider_handle: structuredClone(providerHandle) } : {}),
          ...(checkpoint !== undefined ? { checkpoint: structuredClone(checkpoint) } : {}),
          ...(evidence !== undefined ? { evidence: structuredClone(evidence) } : {}),
          ...(failure !== undefined ? { failure: structuredClone(failure) } : {}),
          updated_at: now(),
        });
        await atomicWrite(attemptPath(id), next);
        return next;
      });
    },
  };
}
