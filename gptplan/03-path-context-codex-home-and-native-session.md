# 03 PathContext、项目级 CODEX_HOME 与原生 Session 修复方案

## 目标

消除路径语义混乱、固定用户名硬编码、`.codex/.codex/sessions` 错误和 exec/TUI session 归属不明确问题。

## 主要文件

### 新增

- `backend/src/path-context/path-context-schema.mjs`
- `backend/src/path-context/path-context-resolver.mjs`
- `backend/src/path-context/path-context-validator.mjs`
- `backend/src/path-context/codex-home-resolver.mjs`
- `backend/src/path-context/codex-process-environment.mjs`
- `backend/src/codex-session/native-session-id-parser.mjs`
- `backend/src/codex-session/codex-session-manifest-store.mjs`
- `backend/src/codex-session/codex-session-inventory.mjs`
- `backend/src/codex-session/codex-session-resolver.mjs`
- `bin/gptwork-codex`

### 修改

- `backend/src/runtime-config.mjs`
- `backend/src/task-codex-execution.mjs`
- `backend/src/codex-tui-pty-adapter.mjs`
- `backend/src/codex-tui-session-manager.mjs`
- `backend/src/codex-execution-provider.mjs`
- `backend/src/tool-groups/session-inventory-tools-group.mjs`
- `backend/src/restart-strategy.mjs`
- `backend/src/safe-restart-detached-scheduler.mjs`
- `backend/src/tool-groups/recovery-tools-group.mjs`
- `backend/src/tool-groups/runtime-status-tools-group.mjs`
- `.gitignore`
- `.gptwork/runtime.env.example`

### 测试

- 新增 `backend/test/path-context-resolver.test.mjs`
- 新增 `backend/test/path-context-boundary.test.mjs`
- 新增 `backend/test/codex-process-environment.test.mjs`
- 新增 `backend/test/native-codex-session-binding.test.mjs`
- 修改 `backend/test/runtime-config.test.mjs`
- 修改 `backend/test/session-inventory-tools-group.test.mjs`
- 修改 `backend/test/codex-tui-session-manager.test.mjs`
- 修改 `backend/test/codex-tui-pty-adapter.test.mjs`

## 唯一路径模型

```js
{
  mcpRoot,
  projectsRoot,
  workspaceRoot,
  projectRoot,
  canonicalRepoPath,
  executionCwd,
  worktreePath,
  codexHome,
  nativeSessionsRoot,
  controlSessionsRoot
}
```

## 实施任务

### Task 1：定义严格语义

- `workspaceRoot` 是多项目或 workspace 容器。
- `projectRoot` 是具体项目根。
- `canonicalRepoPath` 是 canonical Git checkout。
- `worktreePath` 是 task 隔离目录。
- `codexHome` 就是 `CODEX_HOME`，不得再拼 `.codex`。
- `nativeSessionsRoot = join(codexHome, "sessions")`。

### Task 2：PathContext resolver

优先级：

```text
task/worktree binding
→ repository registry
→ explicit project config
→ default repository
→ fail closed
```

禁止回退到 `process.cwd()` 或 `workspaceRoot` 继续执行。

伪代码：

```js
export async function resolvePathContext(input) {
  const canonicalRepoPath = await resolveCanonicalRepo(input);
  if (!canonicalRepoPath) throw new PathContextError("project_root_unresolved");
  const projectRoot = canonicalRepoPath;
  const worktreePath = resolveValidatedWorktree(input.task, canonicalRepoPath);
  const codexHome = resolveCodexHome({ config: input.config, projectRoot });
  return validatePathContext({...});
}
```

### Task 3：边界验证

- canonical repo 必须包含 `.git` 或通过 `git rev-parse`。
- worktree 必须属于 canonical repo。
- project mode 下 codexHome 必须位于 projectRoot。
- session root 不得路径逃逸。
- projectsRoot 不得被当成 projectRoot。

### Task 4：配置模式

新增：

```text
GPTWORK_CODEX_HOME_MODE=project|user|explicit
GPTWORK_CODEX_HOME=<only for explicit>
```

默认 `project`：

```js
join(projectRoot, ".codex-runtime")
```

user 模式：

```js
join(homedir(), ".codex")
```

### Task 5：统一进程环境构造器

```js
export function buildCodexProcessEnvironment(pathContext, bindings, baseEnv) {
  return {
    ...baseEnv,
    CODEX_HOME: pathContext.codexHome,
    GPTWORK_PROJECT_ROOT: pathContext.projectRoot,
    GPTWORK_CANONICAL_REPO_PATH: pathContext.canonicalRepoPath,
    GPTWORK_EXECUTION_CWD: pathContext.executionCwd,
    GPTWORK_TASK_ID: bindings.taskId,
    GPTWORK_GOAL_ID: bindings.goalId,
    GPTWORK_EXECUTION_ID: bindings.executionId,
    GPTWORK_CONTROL_SESSION_ID: bindings.controlSessionId
  };
}
```

exec 和 TUI 必须共用此函数。

### Task 6：删除硬编码

必须移除生产代码中的：

```text
/home/a9017/.codex/...
/home/a9017/mcp/workspace/...
```

替代来源：

- `os.homedir()`
- PathContext
- module URL 推导
- explicit config

新增测试扫描 `backend/src`，发现 `/home/a9017` 直接失败。

### Task 7：修复 session inventory

从：

```js
join(config.codexHome, ".codex", "sessions")
```

改为：

```js
join(pathContext.codexHome, "sessions")
```

输入必须包含 `project_id` 或可解析的 task/goal/session 标识。

### Task 8：捕获 native session ID

exec 从输出解析：

```js
/^session id:\s*([A-Za-z0-9-]+)/im
```

TUI 使用两级策略：

1. 解析初始化输出。
2. 在项目级 sessions root 做启动前后差分，并用 PID、cwd、时间窗绑定。

禁止简单取“最新 session”。

### Task 9：session manifest

路径：

```text
<projectRoot>/.gptwork/codex-sessions/manifests/<control-id>.json
```

记录 control session、native session、task、goal、execution、cwd、codexHome、provider、状态。

### Task 10：项目级 wrapper

`bin/gptwork-codex`：

```bash
#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
export CODEX_HOME="${PROJECT_ROOT}/.codex-runtime"
mkdir -p "${CODEX_HOME}"
exec codex "$@"
```

### Task 11：双读单写迁移

写入只写项目级新目录；读取顺序：

1. 项目级新 root。
2. 旧显式 root。
3. 用户级 root。

旧 root 只读，迁移必须复制、hash 校验，不删除源。

## 验收命令

```bash
cd backend
node --test test/path-context-resolver.test.mjs
node --test test/path-context-boundary.test.mjs
node --test test/codex-process-environment.test.mjs
node --test test/native-codex-session-binding.test.mjs
node --test test/runtime-config.test.mjs
node --test test/session-inventory-tools-group.test.mjs
node --test test/codex-tui-pty-adapter.test.mjs
npm run check:syntax
npm run check:imports
```

## 完成标准

- 任意用户名、任意安装目录可运行。
- exec/TUI 使用当前项目的同一 `CODEX_HOME`。
- task 与 native Codex session 双向可追溯。
- 两个项目 session 不串读。
