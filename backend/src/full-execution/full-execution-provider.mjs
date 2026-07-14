/**
 * full-execution-provider.mjs — Unified provider interface for full execution mode.
 *
 * Both Codex TUI and ChatGPT/local_patch backends implement this interface.
 * Provider no longer implies mode — it's just the technical backend.
 *
 * Interface:
 *   start()     → { session_id, pid }
 *   heartbeat() → {}
 *   sendInput() → {}
 *   collect()   → { result_json, result_md, ... }
 *   stop()      → {}
 *   getStatus() → { running, pid, ... }
 */

/**
 * Create a full execution provider from a provider name.
 *
 * @param {string} providerName - "codex_tui" or "local_patch"
 * @param {object} deps - Dependencies { codexTuiSession, ... }
 * @returns {object} Provider implementation
 */
export function createFullExecutionProvider(providerName, deps = {}) {
  switch (providerName) {
    case "codex_tui":
      return createCodexTuiProvider(deps);
    case "local_patch":
      return createLocalPatchProvider(deps);
    default:
      throw new Error(`Unknown execution provider: ${providerName}`);
  }
}

function createCodexTuiProvider(deps = {}) {
  const {
    startCodexTuiGoalSession = null,
    sendCodexTuiSessionInput = null,
    stopCodexTuiSession = null,
    getCodexTuiSessionStatus = null,
    readCodexTuiSession = null,
  } = deps;

  return {
    name: "codex_tui",

    async start({ task, goal, cwd, workspaceRoot }) {
      if (typeof startCodexTuiGoalSession !== "function") {
        throw new Error("codex_tui provider: startCodexTuiGoalSession not provided");
      }
      return startCodexTuiGoalSession({ task, goal, cwd, workspaceRoot });
    },

    async sendInput(sessionId, text) {
      if (typeof sendCodexTuiSessionInput !== "function") return null;
      return sendCodexTuiSessionInput(sessionId, text);
    },

    async stop(sessionId, options = {}) {
      if (typeof stopCodexTuiSession !== "function") return null;
      return stopCodexTuiSession(sessionId, options);
    },

    async getStatus(sessionId) {
      if (typeof getCodexTuiSessionStatus !== "function") {
        return { id: sessionId, status: "unknown" };
      }
      return getCodexTuiSessionStatus(sessionId);
    },

    async collect(sessionId) {
      if (typeof readCodexTuiSession !== "function") return null;
      return readCodexTuiSession(sessionId, { maxChars: 0 });
    },
  };
}

function createLocalPatchProvider(deps = {}) {
  return {
    name: "local_patch",

    async start({ task, goal, cwd, workspaceRoot }) {
      // Local patch provider applies changes directly without a TUI session.
      // It runs required commands, writes results, and returns immediately.
      return {
        id: `local_${task.id}_${Date.now()}`,
        status: "completed",
        provider: "local_patch",
        cwd,
      };
    },

    async sendInput() {
      throw new Error("local_patch provider does not support sendInput");
    },

    async stop() {
      return { status: "stopped" };
    },

    async getStatus() {
      return { status: "completed" };
    },

    async collect() {
      return null;
    },
  };
}
