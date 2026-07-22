import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

function pathEntries(baseEnv = process.env) {
  return String(baseEnv.PATH || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function candidateCodexPaths(baseEnv = process.env) {
  const home = baseEnv.HOME || process.env.HOME || "";
  const npmGlobal = home ? join(home, ".npm-global") : null;
  const nativeLinux = npmGlobal
    ? join(
      npmGlobal,
      "lib",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-linux-x64",
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
      "codex",
    )
    : null;
  const extras = [
    baseEnv.GPTWORK_CODEX_COMMAND || process.env.GPTWORK_CODEX_COMMAND || null,
    baseEnv.CODEX_PATH || process.env.CODEX_PATH || null,
    nativeLinux,
    npmGlobal ? join(npmGlobal, "bin", "codex") : null,
    home ? join(home, ".local", "bin", "codex") : null,
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ].filter(Boolean);
  const fromPath = pathEntries(baseEnv).map((dir) => join(dir, "codex"));
  return [...new Set([...extras, ...fromPath])];
}

/**
 * Resolve an executable path for the Codex CLI.
 * Prefer absolute paths so PTY/script spawns work even when service PATH is thin.
 */
export function resolveCodexCommandPath({
  command = "codex",
  baseEnv = process.env,
} = {}) {
  const requested = String(command || "codex").trim() || "codex";
  if (requested.includes("/") || requested.startsWith(".")) {
    if (existsSync(requested)) return requested;
  }
  for (const candidate of candidateCodexPaths(baseEnv)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  try {
    const which = execFileSync("which", [requested], {
      encoding: "utf8",
      timeout: 3000,
      env: baseEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (which && existsSync(which)) return which;
  } catch {
    // fall through
  }
  return requested;
}

export function ensureCodexCommandOnPath(env = {}, commandPath = null) {
  const next = { ...env };
  const resolved = commandPath || resolveCodexCommandPath({ baseEnv: next });
  const home = next.HOME || process.env.HOME || "";
  const extras = [];
  if (resolved && resolved.includes("/")) extras.push(dirname(resolved));
  if (home) {
    extras.push(join(home, ".npm-global", "bin"));
    extras.push(join(home, ".local", "bin"));
    extras.push(join(
      home,
      ".npm-global",
      "lib",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-linux-x64",
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
    ));
  }
  // node-pty execvp needs both the codex wrapper dir and a node binary dir.
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) extras.push(dir);
  const parts = pathEntries(next);
  const merged = [];
  for (const dir of [...extras, ...parts]) {
    if (dir && !merged.includes(dir)) merged.push(dir);
  }
  next.PATH = merged.join(delimiter);
  return next;
}

export function buildCodexProcessEnvironment(pathContext = {}, bindings = {}, baseEnv = process.env) {
  const required = ["projectRoot", "canonicalRepoPath", "executionCwd"];
  for (const field of required) {
    if (!pathContext[field]) throw new TypeError(`pathContext.${field} is required`);
  }
  const env = {
    ...baseEnv,
    GPTWORK_PROJECT_ROOT: pathContext.projectRoot,
    GPTWORK_CANONICAL_REPO_PATH: pathContext.canonicalRepoPath,
    GPTWORK_EXECUTION_CWD: pathContext.executionCwd,
  };
  // Intentionally omit CODEX_HOME so Codex uses the user-default home.
  // pathContext.nativeSessionsRoot is resolved independently for inventory/binding.
  delete env.CODEX_HOME;
  delete env.GPTWORK_CODEX_HOME;
  delete env.GPTWORK_CODEX_HOME_MODE;
  const optionalBindings = {
    GPTWORK_TASK_ID: bindings.taskId,
    GPTWORK_GOAL_ID: bindings.goalId,
    GPTWORK_EXECUTION_ID: bindings.executionId,
    GPTWORK_CONTROL_SESSION_ID: bindings.controlSessionId,
  };
  for (const [key, value] of Object.entries(optionalBindings)) {
    if (value !== null && value !== undefined && String(value) !== "") env[key] = String(value);
    else delete env[key];
  }
  return env;
}
