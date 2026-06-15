import { readFileSync, existsSync } from "node:fs";

/**
 * Load a simple KEY=VALUE env file, filling only missing process.env keys.
 *
 * Default path: <workspaceRoot>/.gptwork/runtime.env
 * Override:     GPTWORK_RUNTIME_ENV_FILE (absolute or relative to workspace root)
 *
 * Ignores blank lines and lines starting with #.
 * process.env values always take priority.
 *
 * Returns { loadedPath, keys } where keys is the list of variable names loaded.
 */
export function loadRuntimeEnv(workspaceRoot, overridePath) {
  const filePath = resolveEnvFilePath(workspaceRoot, overridePath);
  if (!filePath || !existsSync(filePath)) {
    return { loadedPath: null, keys: [] };
  }

  const text = readFileSync(filePath, "utf8");
  const keys = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const k = line.slice(0, eqIdx).trim();
    const v = line.slice(eqIdx + 1).trim();
    if (!k) continue;
    // Only set if not already in process.env
    if (process.env[k] === undefined) {
      process.env[k] = v;
      keys.push(k);
    }
  }

  return { loadedPath: filePath, keys };
}

function resolveEnvFilePath(workspaceRoot, overridePath) {
  if (overridePath) {
    // If absolute, use directly; otherwise resolve relative to workspace root
    if (overridePath.startsWith("/")) return overridePath;
    return `${workspaceRoot.replace(/\/+$/, "")}/${overridePath}`;
  }
  // Default: .gptwork/runtime.env under workspace root
  return `${workspaceRoot.replace(/\/+$/, "")}/.gptwork/runtime.env`;
}
