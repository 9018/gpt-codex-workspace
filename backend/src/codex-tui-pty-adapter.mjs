import { spawn as spawnChild, execFileSync } from "node:child_process";

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

function buildCommand(cmd, promptArgs = []) {
  // Build the shell command for script fallback.
  // Only the command name is quoted; the prompt should NOT be passed as
  // argv to an interactive TUI — it is submitted via stdin after ready.
  return [cmd, ...promptArgs].map(shellQuote).join(" ");
}

function createTerminalNotifier(onExit) {
  let notified = false;
  return (event) => {
    if (notified) return;
    notified = true;
    onExit?.(event);
  };
}

function createScriptFallbackSession({ cwd, env, onData, onExit, spawnImpl, args = [], command = "codex" } = {}) {
  // Launch codex bare via script(1). The prompt is NOT passed as argv;
  // it is submitted via stdin after the TUI is ready.
  const proc = spawnImpl("script", ["-q", "-f", "-c", buildCommand(command, args), "/dev/null"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  proc.stdout?.on?.("data", (chunk) => onData?.(String(chunk)));
  proc.stderr?.on?.("data", (chunk) => onData?.(String(chunk)));
  const cleanupProcessGroup = (signal = "SIGTERM") => {
    if (!proc.pid || process.platform === "win32") return;
    try { process.kill(-proc.pid, signal); } catch { /* group may already be gone */ }
  };
  const notifyExit = createTerminalNotifier((event) => {
    cleanupProcessGroup();
    onExit?.(event);
  });
  const onError = (error) => notifyExit({
    exit_code: null,
    signal: null,
    source: "script-error",
    error: error?.message || String(error),
    error_code: error?.code || null,
  });
  const onProcessExit = (exitCode, signal) => notifyExit({
    exit_code: exitCode ?? null,
    signal: signal ?? null,
    source: "script-exit",
  });
  const onClose = (exitCode, signal) => notifyExit({
    exit_code: exitCode ?? null,
    signal: signal ?? null,
    source: "script-close",
  });
  proc.on?.("error", onError);
  proc.on?.("exit", onProcessExit);
  proc.on?.("close", onClose);

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
      cleanupProcessGroup(signal);
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


/**
 * Proactively check whether PTY support is available for the current
 * runtime environment.  Returns a structured availability report.
 *
 * The report includes:
 *  - node_pty:   whether node-pty can be imported (preferred)
 *  - script:     whether script(1) fallback is available on PATH
 *  - available:  whether any PTY mechanism is usable
 *  - diagnostic: human-readable explanation if unavailable
 *  - detail:     resolution hints
 */
export async function checkPtyAvailability() {
  const result = {
    node_pty: false,
    node_pty_error: null,
    script: false,
    script_error: null,
    available: false,
    diagnostic: null,
    detail: null,
  };

  // Check node-pty
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    req("node-pty");
    result.node_pty = true;
  } catch (err) {
    result.node_pty_error = err?.message || "unknown error";
  }

  // Check script(1)
  try {
    execFileSync("which", ["script"], { stdio: "ignore", timeout: 5000 });
    result.script = true;
  } catch (err) {
    result.script_error = err?.message || "not found on PATH";
  }

  if (result.node_pty) {
    result.available = true;
    result.diagnostic = null;
    result.detail = "node-pty is installed and available.";
  } else if (result.script) {
    result.available = true;
    result.diagnostic = "Script fallback via script(1)";
    result.detail = "node-pty is NOT installed; using script(1) fallback. For reliable TUI sessions, install node-pty: npm install node-pty";
  } else {
    result.available = false;
    result.diagnostic = "No PTY support available";
    result.detail = "node-pty is not installed and script(1) is not found on PATH. Install node-pty via: npm install node-pty, or ensure script(1) is available on the system.";
  }

  return result;
}

export function createAgentTuiPtyAdapter({
  pty = undefined,
  loadPty = loadNodePty,
  allowScriptFallback = false,
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
    async spawn({ cwd, onData, onExit, args = [], command: spawnCommand } = {}) {
      const env = {
        ...process.env,
        TERM: "xterm-256color",
      };
      const cmd = spawnCommand || defaultCommand;

      const resolvedPty = await resolvePty();
      if (!resolvedPty?.spawn) {
        if (pty !== undefined || !allowScriptFallback) throw makeUnavailableError();
        return createScriptFallbackSession({ cwd, env, onData, onExit, spawnImpl, args, command: cmd });
      }

      const proc = resolvedPty.spawn(cmd, args, {
        name: "xterm-256color",
        cwd,
        cols: 120,
        rows: 40,
        env,
      });

      let stopped = false;
      const dataDisposable = proc.onData ? proc.onData((chunk) => onData?.(chunk)) : null;
      const notifyExit = createTerminalNotifier(onExit);
      const exitDisposable = proc.onExit ? proc.onExit(({ exitCode, signal } = {}) => notifyExit({
        exit_code: exitCode ?? null,
        signal: signal ?? null,
        source: "node-pty-exit",
      })) : null;

      return {
        pid: proc.pid ?? null,
        adapter: "node-pty",
        write(text) {
          proc.write(String(text ?? ""));
        },
        stop(signal = "SIGTERM") {
          if (stopped) return;
          stopped = true;
          try { dataDisposable?.dispose?.(); } catch { /* non-fatal */ }
          try { exitDisposable?.dispose?.(); } catch { /* non-fatal */ }
          try { proc.kill?.(signal); } catch { /* non-fatal */ }
        },
      };
    },
  };
}
