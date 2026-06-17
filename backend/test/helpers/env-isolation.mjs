/**
 * Test isolation: save host GPTWORK_* env vars and clear before each test.
 *
 * Import this module at the top of any test file to prevent parent-process
 * GPTWORK_* values from contaminating tests that create temporary workspaces
 * with their own runtime.env files.
 *
 * Usage:
 *   import "../helpers/env-isolation.mjs";
 *
 * The module-level code dynamically discovers all GPTWORK_* vars and clears
 * them from process.env at import time.  The original values are restored on
 * process exit.
 *
 * The `clearGptWorkVars()` helper can be called inside individual tests to
 * re-clear after a test has temporarily set GPTWORK_* values.
 */

/** Dynamically discover all GPTWORK_* env vars currently set. */
function _discoverGptWorkVars() {
  return Object.keys(process.env).filter(k => k.startsWith("GPTWORK_"));
}

/** Snapshot of GPTWORK_* vars present in process.env at module load time. */
const _GPTWORK_VARS = _discoverGptWorkVars();

const _savedEnv = {};
for (const _k of _GPTWORK_VARS) {
  if (_k in process.env) { _savedEnv[_k] = process.env[_k]; delete process.env[_k]; }
}
process.on("exit", () => {
  for (const [_k, _v] of Object.entries(_savedEnv)) { process.env[_k] = _v; }
});

/**
 * Clear all GPTWORK_* env vars dynamically for intra-test isolation.
 * Call this inside individual tests that set GPTWORK_* values temporarily.
 */
export function clearGptWorkVars() {
  for (const _k of Object.keys(process.env)) {
    if (_k.startsWith("GPTWORK_")) {
      delete process.env[_k];
    }
  }
}

export { _GPTWORK_VARS, _savedEnv };
