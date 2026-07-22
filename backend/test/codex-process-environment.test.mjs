import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexProcessEnvironment, resolveCodexCommandPath, ensureCodexCommandOnPath } from "../src/path-context/codex-process-environment.mjs";
import { existsSync } from "node:fs";
import { executeCodexTaskRun } from "../src/task-codex-execution.mjs";
import { createCodexTuiPtyAdapter } from "../src/codex-tui-pty-adapter.mjs";

const pathContext = {
  projectRoot: "/repos/project",
  canonicalRepoPath: "/repos/project",
  executionCwd: "/worktrees/task-1",
};

test("buildCodexProcessEnvironment binds project and execution identifiers", () => {
  const env = buildCodexProcessEnvironment(pathContext, {
    taskId: "task_1",
    goalId: "goal_1",
    executionId: "exec_1",
    controlSessionId: "control_1",
  }, { PATH: "/bin", CODEX_HOME: "/wrong" });

  assert.equal(env.PATH, "/bin");
  assert.equal("CODEX_HOME" in env, false);
  assert.equal(env.GPTWORK_PROJECT_ROOT, "/repos/project");
  assert.equal(env.GPTWORK_CANONICAL_REPO_PATH, "/repos/project");
  assert.equal(env.GPTWORK_EXECUTION_CWD, "/worktrees/task-1");
  assert.equal(env.GPTWORK_TASK_ID, "task_1");
  assert.equal(env.GPTWORK_GOAL_ID, "goal_1");
  assert.equal(env.GPTWORK_EXECUTION_ID, "exec_1");
  assert.equal(env.GPTWORK_CONTROL_SESSION_ID, "control_1");
});

test("exec and TUI both omit CODEX_HOME and use the resolved execution cwd", async () => {
  let execEnv = null;
  await executeCodexTaskRun({
    config: { codexExecArgs: "", codexExecTimeout: 5, defaultWorkspaceRoot: "/workspace" },
    workspaceRoot: "/workspace",
    executionCwd: pathContext.executionCwd,
    pathContext,
    task: { id: "task_1" },
    goal: { id: "goal_1" },
    executionId: "exec_1",
    promptFile: "/tmp/prompt.txt",
    runLocalShellFn: async (_cmd, _cwd, _timeout, _max, _onPid, options) => {
      execEnv = options.env;
      return { stdout: "STATUS=completed\nSUMMARY=ok", stderr: "session id: native-exec-1", returncode: 0 };
    },
    parseCodexResultFn: async () => ({ status: "completed", summary: "ok", structured: true }),
  });

  const calls = [];
  const fakePty = {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { pid: 42, write() {}, kill() {}, onData() {}, onExit() {} };
    },
  };
  const adapter = createCodexTuiPtyAdapter({ pty: fakePty });
  const tuiEnv = buildCodexProcessEnvironment(pathContext, { taskId: "task_1", goalId: "goal_1" }, { PATH: "/bin" });
  await adapter.spawn({ cwd: pathContext.executionCwd, env: tuiEnv });

  assert.equal("CODEX_HOME" in execEnv, false);
  assert.equal("CODEX_HOME" in calls[0].options.env, false);
  assert.equal(calls[0].options.cwd, pathContext.executionCwd);
  assert.equal(execEnv.GPTWORK_PROJECT_ROOT, calls[0].options.env.GPTWORK_PROJECT_ROOT);
});


test("resolveCodexCommandPath finds npm-global codex even when PATH is thin", () => {
  const resolved = resolveCodexCommandPath({
    command: "codex",
    baseEnv: { PATH: "/usr/bin", HOME: process.env.HOME },
  });
  assert.ok(resolved.includes("/"), resolved);
  assert.equal(existsSync(resolved), true);
});

test("ensureCodexCommandOnPath prepends codex directory without dropping existing PATH", () => {
  const resolved = resolveCodexCommandPath({
    command: "codex",
    baseEnv: { PATH: "/usr/bin", HOME: process.env.HOME },
  });
  const env = ensureCodexCommandOnPath({ PATH: "/usr/bin", HOME: process.env.HOME }, resolved);
  const dir = resolved.slice(0, resolved.lastIndexOf("/"));
  assert.ok(env.PATH.startsWith(dir));
  assert.ok(env.PATH.includes("/usr/bin"));
});
