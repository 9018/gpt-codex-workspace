# P0-2 Goal：task schema 与 StateStore 持久化 worktree/attempt 字段

## 目标

让 task 对象可以记录 execution mode、worktree 信息、attempt/retry 信息，并兼容旧 task。

## 涉及文件

优先检查并修改：

```text
backend/src/goal-task-task-factory.mjs
backend/src/task-lifecycle.mjs
backend/src/state-store.mjs
backend/src/goal-queue.mjs
backend/src/tool-groups/task-execution-tools-group.mjs
```

实际文件名不同则用 search/grep 查 task 创建和 update 逻辑。

## 必须新增字段

普通 builder task 默认包含：

```json
{
  "execution_mode": "worktree",
  "repo_id": "default",
  "base_ref": "main",
  "base_sha": null,
  "worktree": {
    "enabled": true,
    "path": null,
    "branch": null,
    "base_ref": "main",
    "base_sha": null,
    "head_sha": null,
    "status": "pending"
  },
  "attempt": 0,
  "max_attempts": 2,
  "failure_class": null,
  "repair_of_attempt": null
}
```

## 兼容要求

读取旧 task 时不能报错。必须有 normalize 逻辑：

```js
function normalizeTaskExecutionFields(task) {
  task.execution_mode ||= task.mode === 'builder' ? 'worktree' : 'canonical'
  task.attempt ??= 0
  task.max_attempts ??= 2
  task.worktree ||= { enabled: task.execution_mode === 'worktree', status: 'pending' }
  return task
}
```

## 模式规则

| task.mode | execution_mode 默认值 |
|---|---|
| builder | worktree |
| readonly | canonical 或 none |
| deploy | canonical |
| admin | canonical |

只有 builder 默认 worktree。deploy/admin 仍用 canonical lock 保护。

## 验收标准

- [ ] 新创建 builder task 有 execution_mode/worktree/attempt/max_attempts。
- [ ] deploy/admin 不默认 worktree。
- [ ] 旧 task 仍能被 worker/queue 读取。
- [ ] StateStore 保存/读取不丢字段。
- [ ] 测试覆盖旧 task normalization。
