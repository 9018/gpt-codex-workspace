# P0-4 Goal：让 Codex worker 在 task worktree 内执行

## 目标

Codex 执行目录必须是 `task.worktree.path`，而不是 `config.defaultRepoPath`。这是多任务隔离的核心。

## 涉及文件

```text
backend/src/task-general-processor.mjs
backend/src/task-run-setup.mjs
backend/src/task-codex-execution.mjs
backend/src/codex-prompt-builder.mjs
backend/src/codex-run-metadata.mjs
backend/test/task-run-setup.test.mjs
backend/test/codex-prompt-builder.test.mjs
```

## 当前问题

当前 task-general-processor 在执行前获取 canonical repo lock：

```js
const repoLockPath = config.defaultRepoPath;
await acquireRepoLock(config.defaultWorkspaceRoot, repoLockPath, ...)
```

当前 prepareCodexTaskRun 传：

```js
defaultRepoPath: config.defaultRepoPath
repoPath: config.defaultRepoPath
```

## 新逻辑

### 1. 解析执行 repo path

新增 helper：

```js
export function resolveTaskRepoPath(task, config) {
  if (task.execution_mode === 'worktree' && task.worktree?.enabled && task.worktree?.path) {
    return task.worktree.path
  }
  return config.defaultRepoPath
}
```

### 2. lock 策略

普通 builder + worktree：

- 不在整个执行期持有 canonical repo lock。
- 只在 worktree 创建/删除/merge 检查时短暂 lock。

canonical/deploy/admin：

- 保持原 lock 策略。

### 3. Codex prompt

prompt 必须明确写：

```text
You are running inside an isolated git worktree for this task.
Do not modify the canonical repository path.
Task branch: <branch>
Base sha: <base_sha>
```

### 4. run metadata

`initRun` 的 repoPath 应为实际执行 path：

```js
repoPath: taskRepoPath
```

### 5. result 写回

即使 Codex 在 worktree 内执行，goal workspace 仍写到 canonical workspace：

```text
.gptwork/goals/<goal_id>/result.json
.gptwork/goals/<goal_id>/result.md
.gptwork/goals/<goal_id>/verification.json
```

## 验收标准

- [ ] builder task with worktree 时，Codex cwd 是 `task.worktree.path`。
- [ ] builder task 不在整个执行期 acquire canonical repo lock。
- [ ] deploy/admin 仍使用 canonical repo lock。
- [ ] prompt 明确说明 isolated worktree。
- [ ] result 仍写回 goal workspace。
- [ ] 测试验证 `resolveTaskRepoPath`。
