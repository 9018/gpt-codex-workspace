import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAgentTuiPtyAdapter, createCodexTuiPtyAdapter, createAgentTuiUnavailableError } from "../src/codex-tui-pty-adapter.mjs";

function makeFakePty() {
  const calls = [];
  const writes = [];
  const killed = [];
  let dataHandler = null;
  const process = {
    pid: 42,
    write(text) { writes.push(text); },
    kill(signal) { killed.push(signal); },
    onData(handler) { dataHandler = handler; return { dispose() {} }; },
    emitData(text) { dataHandler?.(text); },
  };
  return {
    calls, writes, killed, process,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return process;
    },
  };
}

function makeFakeChildProcess() {
  const calls = [];
  const stdinWrites = [];
  const killed = [];
  const child = new EventEmitter();
  child.pid = 99;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(text) { stdinWrites.push(text); },
    end() { stdinWrites.push("[end]"); },
  };
  child.kill = (signal) => killed.push(signal);
  function spawnImpl(command, args, options) {
    calls.push({ command, args, options });
    return child;
  }
  return { calls, stdinWrites, killed, child, spawnImpl };
}

test("createAgentTuiPtyAdapter with default command uses 'codex'", async () => {
  const fakePty = makeFakePty();
  const adapter = createAgentTuiPtyAdapter({ pty: fakePty });

  const session = await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(fakePty.calls[0].command, "codex");
});

test("createAgentTuiPtyAdapter with 'claude' command spawns claude", async () => {
  const fakePty = makeFakePty();
  const adapter = createAgentTuiPtyAdapter({ pty: fakePty, command: "claude" });

  await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(fakePty.calls[0].command, "claude");
});

test("createAgentTuiPtyAdapter passes per-spawn command override", async () => {
  const fakePty = makeFakePty();
  const adapter = createAgentTuiPtyAdapter({ pty: fakePty, command: "codex" });

  await adapter.spawn({ cwd: "/repo", command: "claude", onData() {} });

  assert.equal(fakePty.calls[0].command, "claude");
});

test("createAgentTuiPtyAdapter passes safe argv for claude", async () => {
  const fakePty = makeFakePty();
  const adapter = createAgentTuiPtyAdapter({ pty: fakePty, command: "claude" });

  await adapter.spawn({ cwd: "/repo", args: ["--model", "claude-opus-4"], onData() {} });

  assert.equal(fakePty.calls[0].command, "claude");
  assert.deepEqual(fakePty.calls[0].args, ["--model", "claude-opus-4"]);
});

test("createCodexTuiPtyAdapter still uses 'codex' for backward compat", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });

  await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(fakePty.calls[0].command, "codex");
});

test("createCodexTuiPtyAdapter passes command option through", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty, command: "claude" });

  await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(fakePty.calls[0].command, "claude");
});

test("createAgentTuiUnavailableError mentions correct provider name", () => {
  const err = createAgentTuiUnavailableError(undefined, "codex");
  assert.match(err.message, /codex_tui_goal/);

  const err2 = createAgentTuiUnavailableError(undefined, "claude");
  assert.match(err2.message, /claude_tui_goal/);
});

test("createAgentTuiUnavailableError defaults to agent", () => {
  const err = createAgentTuiUnavailableError();
  assert.match(err.message, /agent_tui_goal/);
  assert.equal(err.code, "codex_tui_unavailable");
});

test("createCodexTuiUnavailableError backward compat", async () => {
  const { createCodexTuiUnavailableError } = await import("../src/codex-tui-pty-adapter.mjs");
  const err = createCodexTuiUnavailableError();
  assert.match(err.message, /codex_tui_goal/);
  assert.equal(err.code, "codex_tui_unavailable");
});

test("script fallback uses claude command", async () => {
  const fakeChild = makeFakeChildProcess();
  const output = [];
  const adapter = createAgentTuiPtyAdapter({
    command: "claude",
    loadPty: async () => { throw createAgentTuiUnavailableError(); },
    spawnImpl: fakeChild.spawnImpl,
  });

  const session = await adapter.spawn({
    cwd: "/repo",
    args: ["--model", "opus"],
    onData: (chunk) => output.push(chunk),
  });

  assert.equal(session.pid, 99);
  assert.equal(session.adapter, "script");
  assert.equal(fakeChild.calls[0].command, "script");
  // The script fallback should use the claude command in its -c argument
  assert.match(fakeChild.calls[0].args.join(" "), /'claude' '--model' 'opus'/);
});
