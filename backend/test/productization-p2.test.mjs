import "./helpers/env-isolation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLogger, readEvents } from "../src/event-log-service.mjs";
import { createHookBus } from "../src/hook-service.mjs";
import { completeAgentRun, createAgentRun } from "../src/agent-run-service.mjs";
import { StateStore } from "../src/state-store.mjs";

test("event logger appends and reads JSONL lifecycle events", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-events-"));
  const logger = createEventLogger({ workspaceRoot: root });

  const first = await logger.append("agent_run.created", { agent_run_id: "run_1" });
  await logger.append("agent_run.completed", { agent_run_id: "run_1" });
  const text = await readFile(first.path, "utf8");
  const events = await readEvents({ workspaceRoot: root });

  assert.match(text, /agent_run.created/);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "agent_run.completed");
});

test("hook bus dispatches lifecycle events to registered handlers", async () => {
  const bus = createHookBus();
  const seen = [];
  bus.on("onAgentRunCompleted", async (event) => seen.push(event.agent_run.id));

  await bus.emit("onAgentRunCompleted", { agent_run: { id: "run_1" } });

  assert.deepEqual(seen, ["run_1"]);
});

test("agent run service writes events and emits completion hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptwork-agent-events-"));
  const store = new StateStore({ statePath: join(root, "state.json"), defaultWorkspaceRoot: root });
  await store.load();
  const eventLogger = createEventLogger({ workspaceRoot: root });
  const hookBus = createHookBus();
  const seen = [];
  hookBus.on("onAgentRunCompleted", async ({ agent_run }) => seen.push(agent_run.id));

  const created = await createAgentRun(store, { role: "tester", agent: "codex" }, { eventLogger, hookBus });
  await completeAgentRun(store, { agent_run_id: created.agent_run.id, summary: "done" }, { eventLogger, hookBus });
  const events = await readEvents({ workspaceRoot: root });

  assert.deepEqual(events.map((event) => event.type), ["agent_run.created", "agent_run.completed"]);
  assert.deepEqual(seen, [created.agent_run.id]);
});
