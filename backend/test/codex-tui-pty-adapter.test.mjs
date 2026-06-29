import test from "node:test";
import assert from "node:assert/strict";
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

test("pty adapter spawns codex TUI with expected terminal options", async () => {
  const fakePty = makeFakePty();
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });

  const session = await adapter.spawn({ cwd: "/repo", onData() {} });

  assert.equal(session.pid, 42);
  assert.equal(fakePty.calls[0].command, "codex");
  assert.deepEqual(fakePty.calls[0].args, []);
  assert.equal(fakePty.calls[0].options.cwd, "/repo");
  assert.equal(fakePty.calls[0].options.cols, 120);
  assert.equal(fakePty.calls[0].options.rows, 40);
  assert.equal(fakePty.calls[0].options.env.TERM, "xterm-256color");
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

test("pty adapter reports codex_tui_unavailable when PTY support is missing", async () => {
  const adapter = createCodexTuiPtyAdapter({ pty: null, loadPty: async () => null });
  await assert.rejects(
    () => adapter.spawn({ cwd: "/repo" }),
    (err) => err?.code === "codex_tui_unavailable" && /PTY support is unavailable/.test(err.message)
  );

  const err = createCodexTuiUnavailableError();
  assert.equal(err.code, "codex_tui_unavailable");
});
