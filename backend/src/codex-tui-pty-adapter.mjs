export function createCodexTuiUnavailableError(cause) {
  const err = new Error("PTY support is unavailable for codex_tui_goal sessions. Install node-pty or provide a PTY adapter implementation.");
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

export function createCodexTuiPtyAdapter({ pty = undefined, loadPty = loadNodePty } = {}) {
  async function resolvePty() {
    if (pty !== undefined) return pty;
    return loadPty();
  }

  return {
    async spawn({ cwd, onData } = {}) {
      const resolvedPty = await resolvePty();
      if (!resolvedPty?.spawn) throw createCodexTuiUnavailableError();

      const env = {
        ...process.env,
        TERM: "xterm-256color",
      };
      const proc = resolvedPty.spawn("codex", [], {
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
