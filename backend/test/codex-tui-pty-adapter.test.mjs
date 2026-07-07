import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCodexTuiPtyAdapter, createCodexTuiUnavailableError } from "../src/codex-tui-pty-adapter.mjs";

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
    calls,
    writes,
    killed,
    process,
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

test("pty adapter spawns codex TUI with expected terminal options", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });

  const session = await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(session.pid, 42);
  assert.equal(session.adapter, "node-pty");
  assert.equal(fakePty.calls[0].command, "codex");
  assert.deepEqual(fakePty.calls[0].args, []);
  assert.equal(fakePty.calls[0].options.cwd, "/repo");
  assert.equal(fakePty.calls[0].options.cols, 120);
  assert.equal(fakePty.calls[0].options.rows, 40);
  assert.equal(fakePty.calls[0].options.env.TERM, "xterm-256color");
});

test("pty adapter passes safe argv to node-pty", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });

  await adapter.spawn({ cwd: "/repo", args: ["--model", "gpt-test"] });

  assert.deepEqual(fakePty.calls[0].args, ["--model", "gpt-test"]);
});

test("pty adapter writes input and forwards output", async () => {
  const fakePty = makeFakePty();
  const output = [];
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });
  const session = await adapter.spawn({ cwd: "/repo", onData: (chunk) => output.push(chunk) });

  session.write("/goal hello\n");
  fakePty.process.emitData("ready");

  assert.deepEqual(fakePty.writes, ["/goal hello\n"]);
  assert.deepEqual(output, ["ready"]);
});

test("pty adapter stops process safely", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });
  const session = await adapter.spawn({ cwd: "/repo", onData() {} });

  session.stop();
  session.stop();

  assert.deepEqual(fakePty.killed, ["SIGTERM"]);
});

test("pty adapter falls back to script when node-pty import fails", async () => {
  const fakeChild = makeFakeChildProcess();
  const output = [];
  const adapter = createCodexTuiPtyAdapter({
    loadPty: async () => { throw createCodexTuiUnavailableError(); },
    spawnImpl: fakeChild.spawnImpl,
  });

  const session = await adapter.spawn({ cwd: "/repo", args: ["--model", "gpt-test"], onData: (chunk) => output.push(chunk) });

  assert.equal(session.pid, 99);
  assert.equal(session.adapter, "script");
  assert.equal(fakeChild.calls[0].command, "script");
  assert.deepEqual(fakeChild.calls[0].args, ["-q", "-f", "-c", "'codex' '--model' 'gpt-test'", "/dev/null"]);
  assert.equal(fakeChild.calls[0].options.cwd, "/repo");

  session.write("/status\n");
  fakeChild.child.stdout.emit("data", Buffer.from("ok"));
  session.stop();
  session.stop();

  assert.deepEqual(fakeChild.stdinWrites, ["/status\n", "[end]"]);
  assert.deepEqual(output, ["ok"]);
  assert.deepEqual(fakeChild.killed, ["SIGTERM"]);
});

test("pty adapter reports codex_tui_unavailable when PTY support and fallback are missing", async () => {
  const adapter = createCodexTuiPtyAdapter({ pty: null, loadPty: async () => null, allowScriptFallback: false });
  await assert.rejects(
    () => adapter.spawn({ cwd: "/repo" }),
    (err) => err?.code === "codex_tui_unavailable" && /PTY support is unavailable/.test(err.message)
  );

  const err = createCodexTuiUnavailableError();
  assert.equal(err.code, "codex_tui_unavailable");
});
