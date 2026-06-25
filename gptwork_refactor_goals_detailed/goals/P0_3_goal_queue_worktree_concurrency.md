# P0-3 Goal：改造 goal queue，让普通任务创建 worktree 并支持并发启动

## 目标

`goal-queue.mjs` 不能再用 canonical repo 的 lock/dirty 状态阻塞所有普通 builder task。普通 task 应该在依赖满足后创建独立 worktree，然后启动。

## 涉及文件

```text
backend/src/goal-queue.mjs
backend/src/worktree-service.mjs
backend/src/goal-task-task-factory.mjs
backend/src/task-lifecycle.mjs
backend/test/goal-queue.test.mjs
backend/test/multi-task-flow.test.mjs
```

## 当前问题

当前 `startNextQueuedGoal` 类似这样：

```js
const repoPath = config.defaultRepoPath || config.defaultWorkspaceRoot;
const workspaceRoot = config.defaultWorkspaceRoot;
// check active repo locks
// check dirty worktree
// create task
```

这个逻辑会让同一仓库的普通任务全部被 canonical repo lock 串行化。

## 新逻辑

### 1. 分类 task

新增或内联：

```js
function requiresCanonicalRepoLock(mode) {
  return mode === 'deploy' || mode === 'admin'
}

function shouldUseWorktree(mode) {
  return mode === 'builder'
}
```

### 2. queue item 增加字段

入队时允许记录：

```json
{
  "repo_id": "default",
  "base_ref": "main",
  "task_mode": "builder"
}
```

### 3. startNextQueuedGoal 改造

伪代码：

```js
for candidate of sorted:
  check dependency

  const mode = candidate.task_mode || goal.mode || 'builder'

  if (requiresCanonicalRepoLock(mode)) {
    check repo lock
    check canonical dirty
    create canonical task
  } else {
    const task = await createGoalTask(..., { mode: 'builder', execution_mode: 'worktree' })
    const wt = await createTaskWorktree({ repoPath: config.defaultRepoPath, taskId: task.id, baseRef })
    update task.worktree = wt
    candidate.status = 'running'
    candidate.task_id = task.id
  }
```

注意：可以在创建 worktree 的短时间内使用 repo lock，避免同时操作 `.git/worktrees`，但不能在整个 Codex 执行期间持有 canonical repo lock。

## 状态要求

queue item 状态：

```text
waiting -> ready -> running -> completed|failed|waiting_for_review
```

如果 worktree 创建失败：

```text
queue item -> failed 或 blocked
reason 写明 worktree_create_failed
```

## 验收标准

- [ ] 普通 builder task 不因为 active canonical repo lock 被全部阻塞，除非正在创建/删除 worktree。
- [ ] 三个普通 queue item 可以创建三个不同 worktree。
- [ ] deploy/admin 仍受 repo lock 保护。
- [ ] 依赖未满足的 task 不启动。
- [ ] `autoStartNextOnTaskCompleted` 可继续推进队列。
- [ ] 有测试证明 3 个普通任务进入 running/assigned 且 worktree 不同。
