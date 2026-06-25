# P0-8 Goal：三任务并发 demo / 集成测试

## 目标

必须提供一个可执行测试或 demo，证明用户交付链路可用。没有 demo/test，不算交付。

## 必须新增或修改

任选其一或多个：

```text
backend/test/multi-task-flow.test.mjs
backend/test/e2e-product-acceptance.test.mjs
backend/scripts/demo-multi-task.mjs
backend/src/cli.mjs 或 bin/gptwork.mjs
```

## demo 场景

创建临时 git repo，模拟三个普通 builder tasks：

```text
Task A: 修改 backend queue 注释或 fixture A
Task B: 修改 context fixture B
Task C: 修改 worker fixture C
```

要求：

1. 三个 task 入队。
2. 三个 task 依赖均满足。
3. 三个 task 创建三个不同 worktree。
4. 三个 branch 不同。
5. 至少模拟/执行 Codex 完成路径。
6. 每个完成 task 都生成 `result.json` 和 `verification.json`。
7. queue/task/goal 状态一致。
8. 人为制造一个失败任务，确认 repair 一次或 waiting_for_review。

## 可接受的 MVP 模拟

如果真实 Codex CLI 在测试中不可用，可以提供 fake Codex runner 注入：

```js
const fakeCodexRunner = async ({ cwd, prompt }) => {
  // 写 result.json 或返回 parsed result
}
```

但 worktree、queue、verifier、状态同步必须真实跑。

## 验收标准

- [ ] 运行 `npm test` 或指定 test 命令能覆盖 multi-task flow。
- [ ] 日志/断言证明三个 worktree path 不同。
- [ ] builder task 不因 canonical repo lock 全部串行阻塞。
- [ ] completed task 有 verification.json。
- [ ] 失败任务不会误标 completed。
- [ ] 测试文档说明如何运行。
