import { resolve } from "node:path";
import { buildRuntimeConfig } from "./runtime-config.mjs";
import { loadRuntimeEnv } from "./runtime-env.mjs";

export function resolveCliStartupConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const shouldRestore = env !== process.env;
  const touched = new Map();

  if (shouldRestore) {
    for (const [key, value] of Object.entries(env)) {
      touched.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
      process.env[key] = String(value);
    }
  }

  try {
    const workspaceRoot = process.env.GPTWORK_WORKSPACE_ROOT || resolve(cwd, "data/workspaces/default");
    const runtimeEnvFile = process.env.GPTWORK_RUNTIME_ENV_FILE;
    const earlyEnvResult = loadRuntimeEnv(workspaceRoot, runtimeEnvFile);
    const runtimeConfig = buildRuntimeConfig(workspaceRoot, runtimeEnvFile, earlyEnvResult.keys);
    return { ...runtimeConfig, earlyEnvResult };
  } finally {
    if (shouldRestore) {
      for (const [key, previous] of touched.entries()) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("GPTWORK_") && !touched.has(key)) delete process.env[key];
      }
    }
  }
}
