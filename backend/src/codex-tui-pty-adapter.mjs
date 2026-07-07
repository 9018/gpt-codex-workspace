import { spawn as spawnChild } from "node:child_process";

export function createCodexTuiUnavailableError(cause) {
  const err = new Error("PTY support is unavailable for codex_tui_goal sessions. Install node-pty, provide a PTY adapter implementation, or ensure the system script(1) command is available for the fallback adapter.");
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

function codexCommand(args = []) {
  return ["codex", ...args].map(shellQuote).join(" ");
}

function createScriptFallbackSession({ cwd, env, onData, spawnImpl, args = [] } = {}) {
  const proc = spawnImpl("script", ["-q", "-f", "-c", codexCommand(args), "/dev/null"], {
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

  return {
    async spawn({ cwd, onData, args = [] } = {}) {
      const env = {
        ...process.env,
        TERM: "xterm-256color",
      };

      const resolvedPty = await resolvePty();
      if (!resolvedPty?.spawn) {
        if (pty !== undefined || !allowScriptFallback) throw createCodexTuiUnavailableError();
        return createScriptFallbackSession({ cwd, env, onData, spawnImpl, args });
      }

      const proc = resolvedPty.spawn("codex", args, {
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
