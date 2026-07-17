# ChatGPT 定时架构监督与 Codex TUI 纠偏重构方案

基准：当前工作区 `main@1d818da`，工作区存在未提交改动。本方案按当前实际代码编写，不以旧主线代码代替正在开发的实现。

## 目标闭环

```text
ChatGPT 定时任务 / 手动触发
  -> WorkMCP 列举活跃 ExecutionRun
  -> 构建不可变 SupervisorReviewPacket
  -> ChatGPT 进行方向与架构语义审查
  -> 输出结构化 SupervisorDecision
  -> WorkMCP 幂等执行 correction / resume / pause / takeover
  -> 同一 worktree、同一 ExecutionRun、优先同一 native Codex session 继续
  -> 记录结果并等待新 revision
```

## 不可破坏的原则

1. 方向偏离由 ChatGPT 判断；规则只采集事实、触发审查和保护不变量。
2. Supervisor Runtime 不自行判断架构方向是否正确。
3. 审查绑定 `run_version + checkpoint_digest + diff_digest + context_digest`。
4. 同一 review revision 最多执行一次决定。
5. Codex 与 ChatGPT 不得同时持有 worktree 写租约。
6. 纠偏继续同一 Run，不创建替代 Task、新 Goal 或新 worktree。
7. 定时任务只是触发器；审查、决定、命令和执行结果必须持久化。
8. Provider 只报告运行事实；业务方向结论只能来自 ChatGPT review。

## 当前代码结论

已经存在：

- `backend/src/execution-core/execution-run-*`
- `backend/src/execution-core/checkpoint-supervisor-loop.mjs`
- `backend/src/supervisor/supervisor-*`
- `backend/src/dynamic-acceptance/*`
- `backend/src/tool-groups/project-control/*`
- Codex TUI send、structured task delta、progress、collect 等能力
- ChatGPT takeover 状态与 Project Control 基础工具

主要缺口：

- Supervisor loop 没有 durable action executor。
- `checkpoint-supervisor-loop` 与 `checkpoint-acceptance-service` 重复触发、采证和建 checkpoint。
- 当前 acceptance service 依据触发类型固定映射动作，不具备 ChatGPT 架构语义判断。
- correction builder 只拼 missing items，无法表达架构方向、禁止项和验收命令。
- 多处状态写失败被当成 non-fatal，缺少 command 状态与恢复机制。
- takeover 只做状态切换，缺少暂停确认、写租约交接和恢复证明。
- 缺少适合 ChatGPT 定时任务调用的一次性高层工具。

## 文档索引

1. `phase-00-current-state-and-target.md`
2. `phase-01-review-packet-and-decision-contract.md`
3. `phase-02-durable-review-and-command-store.md`
4. `phase-03-tui-correction-and-native-resume.md`
5. `phase-04-chatgpt-takeover-and-handoff.md`
6. `phase-05-scheduled-review-tool-and-runtime.md`
7. `phase-06-tests-canaries-and-migration.md`

## 推荐实施顺序

严格按 Phase 00 -> 06 推进。Phase 01、02 是状态语义和幂等基础，完成前不要把定时任务接入真实 TUI 写操作。

## 最终完成定义

- 方向正确时无写操作。
- 偏离时同一 active TUI 只收到一次 correction。
- active control session 丢失时，可通过 native session 恢复后继续。
- 同一 revision 被重复定时触发时不重复发送。
- 新 diff/checkpoint 产生后可再次审查。
- takeover 前 Codex 已静止并释放写租约。
- ChatGPT 修改、测试后可交还同一 Run。
- 重启后 pending command 可恢复，已完成 command 不重复。
- action 失败有结构化故障和可重试状态。
- Run、Task、TUI session、controller ownership 最终一致。
