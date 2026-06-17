/**
 * Test isolation: save host GPTWORK_* env vars and clear before each test.
 *
 * Import this module at the top of any test file to prevent parent-process
 * GPTWORK_* values (especially GPTWORK_RUNTIME_ENV_FILE which redirects
 * runtime.env loading to the production path) from contaminating tests
 * that create temporary workspaces with their own runtime.env files.
 *
 * Usage:
 *   import "../helpers/env-isolation.mjs";
 *
 * The module-level code clears GPTWORK_* vars from process.env at import
 * time.  The original values are restored on process exit.
 */

const _GPTWORK_VARS = [
  "GPTWORK_HOST","GPTWORK_PORT","GPTWORK_WORKSPACE_ROOT","GPTWORK_STATE_PATH",
  "GPTWORK_RUNTIME_ENV_FILE","GPTWORK_CODEX_EXEC_TIMEOUT","GPTWORK_CODEX_EXEC_ARGS",
  "GPTWORK_CODEX_CONCURRENCY","GPTWORK_DEFAULT_REPO","GPTWORK_DEFAULT_BRANCH",
  "GPTWORK_DEFAULT_REPO_PATH","GPTWORK_DEFAULT_REMOTE",
  "GPTWORK_BARK_ENABLED","GPTWORK_BARK_URL","GPTWORK_BARK_KEY","GPTWORK_BARK_GROUP",
  "GPTWORK_BARK_SOUND","GPTWORK_BARK_LEVEL","GPTWORK_BARK_ICON_URL","GPTWORK_BARK_CLICK_URL","GPTWORK_BARK_BADGE",
  "GPTWORK_GITHUB_ENABLED","GPTWORK_GITHUB_REPO","GPTWORK_GITHUB_TOKEN",
  "GPTWORK_SHELL_TIMEOUT","GPTWORK_MAX_OUTPUT_BYTES","GPTWORK_MAX_READ_BYTES","GPTWORK_MAX_SHELL_OUTPUT_BYTES",
  "GPTWORK_CODEX_HOME","GPTWORK_PYTHON","GPTWORK_LOG_PATH","GPTWORK_REQUIRE_AUTH","GPTWORK_TOKENS","GPTWORK_SSH_SOCKS_PROXY",
  "GPTWORK_TOKEN_CONTEXTS",
];

const _savedEnv = {};
for (const _k of _GPTWORK_VARS) {
  if (_k in process.env) { _savedEnv[_k] = process.env[_k]; delete process.env[_k]; }
}
process.on("exit", () => { for (const [_k, _v] of Object.entries(_savedEnv)) { process.env[_k] = _v; } });

/**
 * Clear all GPTWORK_* env vars for intra-test isolation.
 * Call this inside individual tests that set GPTWORK_* values temporarily.
 */
export function clearGptWorkVars() {
  for (const _k of _GPTWORK_VARS) {
    if (_k in process.env) { delete process.env[_k]; }
  }
}

export { _GPTWORK_VARS, _savedEnv };
