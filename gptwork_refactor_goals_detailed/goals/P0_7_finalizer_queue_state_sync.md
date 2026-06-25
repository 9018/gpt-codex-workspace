# P0-7 Goal：finalizer 写回状态、verification 与 queue 同步闭环

## 目标

`task-final-writeback.mjs` 必须接入 verifier/retry/queue 同步。任务完成后 task/goal/queue/agent 状态不能互相矛盾。

## 涉及文件

```text
backend/src/task-final-writeback.mjs
backend/src/task-general-processor.mjs
backend/src/task-acceptance.mjs
backend/src/task-retry.mjs
backend/src/goal-queue.mjs
backend/src/task-lifecycle.mjs
```

## 当前问题

当前 finalizer 主要：

1. 更新 task。
2. 更新 goal。
3. 写 fallback result.json。
4. release repo lock。

缺少：

1. 独立 verifier。
2. verification.json。
3. repair retry。
4. queue item 状态同步。
5. `autoStartNextOnTaskCompleted` 调用。

## 新流程

伪代码：

```js
const verification = await verifyTaskCompletion({ ... })

if (!verification.passed) {
  const failure = classifyTaskFailure(...)
  if (canRetryTask(task, failure)) {
    await scheduleRepairAttempt(...)
    update task.status = 'assigned' 或 'queued'
    update queue item = 'running'
    return { status: 'repair_scheduled' }
  }
  taskStatus = 'waiting_for_review'
}

if (verification.passed) {
  taskStatus = 'completed'
}

write verification.json
update task
update goal
update queue item by task_id -> taskStatus
release locks if any
autoStartNextOnTaskCompleted(store, config, task)
```

## queue 同步规则

按 `task_id` 找 queue item：

| taskStatus | queue status |
|---|---|
| completed | completed |
| failed | failed |
| waiting_for_review | waiting_for_review 或 blocked_review |
| repair_scheduled | running |

如果找不到 queue item，记录 warning，但不能中断 task 完成。

## 验收标准

- [ ] finalizer 调用 `verifyTaskCompletion`。
- [ ] finalizer 写 `verification.json`。
- [ ] finalizer 调用 retry 逻辑。
- [ ] finalizer 同步 queue item。
- [ ] finalizer 完成后触发 `autoStartNextOnTaskCompleted`。
- [ ] `verification.passed=false` 时不能把 task/goal 标 completed。
