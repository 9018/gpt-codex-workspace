# ChatGPT 定时架构监督与 Codex TUI 纠偏重构方案

基准：当前工作区 `main@1d818da`，工作区存在未提交改动。本方案按当前实际代码编写，不以旧主线代码代替正在开发的实现。

## 目标

建立以下闭环：

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

关键原则：

1. 方向偏离由 ChatGPT 判断，规则只负责采集事实、触发和保证安全不变量。
2. Supervisor Runtime 不自行猜测架构是否正确。
3. 每次审查必须绑定 `run_version + checkpoint_digest + diff_digest + context_digest`。
4. 同一审查 revision 最多执行一次决定。
5. Codex 与 ChatGPT 不得同时拥有 worktree 写权限。
6. 纠偏必须继续同一 Run，不创建替代 Task 或新 worktree。
7. 定时任务是触发器，不是状态存储；所有审查、决定和执行状态必须持久化在项目中。

## 当前代码结论

已存在：

- `backend/src/execution-core/execution-run-*`
- `backend/src/execution-core/checkpoint-supervisor-loop.mjs`
- `backend/src/supervisor/supervisor-*`
- `backend/src/dynamic-acceptance/*`
- `backend/src/tool-groups/project-control/*`
- Codex TUI send、structured task delta、session/read/progress/collect 能力
- ChatGPT takeover 状态与 Project Control 基础工具

主要缺口：

- Supervisor loop 没有 action executor，评估结果没有可靠落地。
- `checkpoint-supervisor-loop` 与 `checkpoint-acceptance-service` 重复触发、采证和创建 checkpoint。
- 当前 acceptance service 依据 `no_progress/git_diff/test_completed/interval` 固定映射决定动作，不具备 ChatGPT 架构判断。
- correction builder 只拼 missing items，缺少架构基线、禁止项、目标文件和验证命令。
- `updateRun` 失败被吞掉，缺少 durable command 与幂等执行。
- takeover 只切换状态，没有完整租约、暂停确认、写权限交接和恢复证明。
- 目前没有适合 ChatGPT 定时任务的一次性高层工具。

## 文档结构

- `phase-00-current-state-and-target.md`：现状审计、目标边界和核心数据流。
- `phase-01-review-packet-and-decision-contract.md`：ChatGPT 审查包与决策合同。
- `phase-02-durable-review-and-command-store.md`：持久化、幂等和租约。
- `phase-03-tui-correction-and-native-resume.md`：同一 TUI 纠偏与 native resume。
- `phase-04-chatgpt-takeover-and-handoff.md`：ChatGPT 接管、Project Control、交还。
- `phase-05-scheduled-review-tool-and-runtime.md`：定时任务高层入口和运行编排。
- `phase-06-tests-canaries-and-migration.md`：测试、Canary、迁移和验收。

## 推荐实施顺序

必须按 Phase 00 -> 06 顺序推进。Phase 01、02 是状态语义基础，未完成前不要直接把定时任务接入真实 TUI 写操作。

## 最终完成定义

至少通过以下端到端 Canary：

1. ChatGPT 认为方向正确：不向 TUI 发送任何内容。
2. ChatGPT 发现方向偏离：同一 active session 只收到一次结构化 correction。
3. 控制 session 丢失但 native session 存在：恢复后发送 correction。
4. 同一 diff/checkpoint 多次定时触发：不重复发送。
5. correction 后代码发生新 revision：允许再次审查。
6. ChatGPT takeover 前 Codex 写租约已释放并确认静止。
7. ChatGPT 修改、测试后可交还同一 Run 给 Codex。
8. 服务重启后待执行命令可恢复，不重复执行已成功命令。
9. 任何 action 失败都保留可诊断状态，不静默吞掉。
10. Run、Task、TUI session 和 controller ownership 投影一致。
