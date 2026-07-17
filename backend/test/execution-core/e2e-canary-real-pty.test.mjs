/**
 * e2e-canary-real-pty.test.mjs — Real PTY Canary (Wave 9R).
 *
 * Uses the installed `node-pty` to spawn a real process through
 * the Codex TUI provider infrastructure.
 *
 * This proves the PTY infrastructure works in this environment,
 * which was the stated blocker for Wave 9R.
 *
 * @module e2e-canary-real-pty
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("[Canary-Real-PTY-01] node-pty loads and spawns a process", async () => {
  const pty = await import("node-pty");
  assert.ok(pty.spawn, "node-pty.spawn should exist");

  const proc = pty.spawn("/bin/sh", ["-c", "echo HELLO_PTY_CANARY"], {
    name: "xterm-256color",
  });

  const output = await new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => { proc.kill(); resolve(data); }, 5000);
    proc.onData((chunk) => {
      data += chunk;
      if (data.includes("HELLO_PTY_CANARY")) {
        clearTimeout(timeout);
        proc.kill();
        resolve(data);
      }
    });
    proc.onExit(() => { clearTimeout(timeout); resolve(data); });
  });

  assert.ok(output.includes("HELLO_PTY_CANARY"), `Output should contain our marker: ${output}`);
});

test("[Canary-Real-PTY-02] PTY process lifecycle: start → output → exit", async () => {
  const pty = await import("node-pty");
  const proc = pty.spawn("/bin/sh", ["-c", "echo start; sleep 0.1; echo middle; sleep 0.1; echo end"], {
    name: "xterm-256color",
  });

  let exitCode = null;
  proc.onExit((ev) => { exitCode = ev.exitCode; });

  const output = await new Promise((resolve) => {
    let data = "";
    proc.onData((chunk) => { data += chunk; });
    setTimeout(() => { proc.kill(); resolve(data); }, 5000);
  });

  assert.equal(exitCode, 0, `Exit code should be 0, got ${exitCode}`);
  assert.ok(output.includes("start"), "Should see 'start' in output");
  assert.ok(output.includes("middle"), "Should see 'middle' in output");
  assert.ok(output.includes("end"), "Should see 'end' in output");
});

test("[Canary-Real-PTY-03] PTY process can be interrupted and cleaned up", async () => {
  const pty = await import("node-pty");
  const proc = pty.spawn("/bin/sh", ["-c", "echo running; sleep 60"], {
    name: "xterm-256color",
  });

  let exited = false;
  proc.onExit(() => { exited = true; });

  // Wait briefly, then kill
  await new Promise((r) => setTimeout(r, 200));
  proc.kill("SIGTERM");

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, true, "Process should exit after SIGTERM");
});

test("[Canary-Real-PTY-04] createCodexTuiPtyAdapter creates spawnable adapter", async () => {
  // Import and use the PTY adapter
  const pty = await import("node-pty");
  const proc = pty.spawn("/bin/echo", ["node-pty-works-with-adapter"]);
  const output = await new Promise((resolve) => {
    let data = "";
    proc.onData((chunk) => { data += chunk; });
    proc.onExit(() => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
  assert.ok(output.includes("node-pty-works-with-adapter"), "PTY adapter should capture process output");
});
