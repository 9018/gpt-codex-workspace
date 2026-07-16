export function buildCodexProcessEnvironment(pathContext = {}, bindings = {}, baseEnv = process.env) {
  const required = ["projectRoot", "canonicalRepoPath", "executionCwd", "codexHome"];
  for (const field of required) {
    if (!pathContext[field]) throw new TypeError(`pathContext.${field} is required`);
  }
  const env = {
    ...baseEnv,
    CODEX_HOME: pathContext.codexHome,
    GPTWORK_PROJECT_ROOT: pathContext.projectRoot,
    GPTWORK_CANONICAL_REPO_PATH: pathContext.canonicalRepoPath,
    GPTWORK_EXECUTION_CWD: pathContext.executionCwd,
  };
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
