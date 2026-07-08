import { spawn as spawnChild } from "node:child_process";

export function createCodexTuiUnavailableError(cause) {
  const err = new Error("PTY support is unavailable for codex_tui_goal sessions. Install node-pty, provide a PTY adapter implementation, or ensure the system script(1) command is available for the fallback adapter.");
  err.code = "codex_tui_unavailable";
  if (cause) err.cause = cause;
  return err;
}

export function createAgentTuiUnavailableError(cause, providerName) {
  const providerTag = providerName ? `${providerName}_tui_goal` : "agent_tui_goal";
  const err = new Error(`PTY support is unavailable for ${providerTag} sessions. Install node-pty, provide a PTY adapter implementation, or ensure the system script(1) command is available for the fallback adapter.`);
  err.code = "codex_tui_unavailable";
  if (cause) err.cause = cause;
  return err;
}

async function loadNodePty() {
  try {
    return await import("node-pty");
  } catch (err) {
    throw createCodexTuiUnavailableError(err);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function buildCommand(cmd, args = []) {
  return [cmd, ...args].map(shellQuote).join(" ");
}

function createScriptFallbackSession({ cwd, env, onData, spawnImpl, args = [], command = "codex" } = {}) {
  const proc = spawnImpl("script", ["-q", "-f", "-c", buildCommand(command, args), "/dev/null"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout?.on?.("data", (chunk) => onData?.(String(chunk)));
  proc.stderr?.on?.("data", (chunk) => onData?.(String(chunk)));

  let stopped = false;
  return {
    pid: proc.pid ?? null,
    adapter: "script",
    write(text) {
      proc.stdin?.write?.(String(text ?? ""));
    },
    stop(signal = "SIGTERM") {
      if (stopped) return;
      stopped = true;
      try { proc.stdin?.end?.(); } catch { /* non-fatal */ }
      try { proc.kill?.(signal); } catch { /* non-fatal */ }
    },
  };
}

export function createCodexTuiPtyAdapter({
  pty = undefined,
  loadPty = loadNodePty,
  allowScriptFallback = true,
  spawnImpl = spawnChild,
  command: defaultCommand = "codex",
} = {}) {
  return createAdapter({
    pty,
    loadPty,
    allowScriptFallback,
    spawnImpl,
    defaultCommand,
  });
}

export function createAgentTuiPtyAdapter({
  pty = undefined,
  loadPty = loadNodePty,
  allowScriptFallback = true,
  spawnImpl = spawnChild,
  command: defaultCommand = "codex",
} = {}) {
  return createAdapter({
    pty,
    loadPty,
    allowScriptFallback,
    spawnImpl,
    defaultCommand,
  });
}

function createAdapter({
  pty = undefined,
  loadPty = loadNodePty,
  allowScriptFallback = true,
  spawnImpl = spawnChild,
  defaultCommand = "codex",
} = {}) {
  async function resolvePty() {
    if (pty !== undefined) return pty;
    try {
      return await loadPty();
    } catch (err) {
      if (allowScriptFallback) return null;
      throw err;
    }
  }

  function makeUnavailableError() {
    if (loadPty === loadNodePty) {
      return createCodexTuiUnavailableError();
    }
    return createAgentTuiUnavailableError();
  }

  return {
    async spawn({ cwd, onData, args = [], command: spawnCommand } = {}) {
      const env = {
        ...process.env,
        TERM: "xterm-256color",
      };
      const cmd = spawnCommand || defaultCommand;

      const resolvedPty = await resolvePty();
      if (!resolvedPty?.spawn) {
        if (pty !== undefined || !allowScriptFallback) throw makeUnavailableError();
        return createScriptFallbackSession({ cwd, env, onData, spawnImpl, args, command: cmd });
      }

      const proc = resolvedPty.spawn(cmd, args, {
        name: "xterm-256color",
        cwd,
        cols: 120,
        rows: 40,
        env,
      });

      let stopped = false;
      const disposable = proc.onData ? proc.onData((chunk) => onData?.(chunk)) : null;

      return {
        pid: proc.pid ?? null,
        adapter: "node-pty",
        write(text) {
          proc.write(String(text ?? ""));
        },
        stop(signal = "SIGTERM") {
          if (stopped) return;
          stopped = true;
          try { disposable?.dispose?.(); } catch { /* non-fatal */ }
          try { proc.kill?.(signal); } catch { /* non-fatal */ }
        },
      };
    },
  };
}
