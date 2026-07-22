import { join } from 'node:path';

export function buildCleanTestEnvironment(runTmpRoot, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GPTWORK_')) delete env[key];
  }
  delete env.CODEX_HOME;
  env.HOME = join(runTmpRoot, 'home');
  env.TMPDIR = runTmpRoot;
  env.TEMP = runTmpRoot;
  env.TMP = runTmpRoot;
  return env;
}
