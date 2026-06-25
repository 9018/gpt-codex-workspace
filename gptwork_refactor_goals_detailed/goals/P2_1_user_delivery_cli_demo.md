# P2-1 Goal：用户侧交付命令与文档

## 目标

让用户能从部署到下发多任务、查看结果、验收状态完整跑通。

## 涉及文件

```text
README.md
docs/operations.md
docs/current-status.md
backend/src/cli.mjs
backend/bin/gptwork.mjs
backend/scripts/demo-multi-task.mjs
```

## 推荐命令

新增或完善：

```bash
gptwork verify-delivery
gptwork demo-multi-task
gptwork queue status
gptwork task inspect <task_id>
gptwork goal inspect <goal_id>
```

## verify-delivery 检查项

```text
Node/npm/git 可用
Codex CLI 可用或 fake runner 可用
repo path 存在且是 git repo
worktree-service 可创建临时 worktree
context bundle 可生成
verifier 可运行 git diff --check
queue/task/goal 状态可读取
```

## demo-multi-task 输出

必须展示：

```json
{
  "tasks_created": 3,
  "worktrees_created": 3,
  "verification_passed": 3,
  "queue_consistent": true
}
```

## 验收标准

- [ ] 用户能按文档启动服务。
- [ ] 用户能运行 demo-multi-task。
- [ ] demo 输出 worktree/branch/task/goal/result 路径。
- [ ] 文档明确哪些是自动完成，哪些需要人工 review。
- [ ] 文档不能代替代码实现。
