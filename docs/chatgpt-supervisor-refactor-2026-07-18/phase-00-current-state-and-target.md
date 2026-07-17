# Phase 00：现状审计、职责收敛与目标架构

## 1. 当前工作区事实

- 分支：`main`
- HEAD：`1d818da5cead48a5ce47f2e8875bddb3c7d9ff65`
- 工作区：dirty
- 正在修改：Execution provider、ExecutionRun、Supervisor、Dynamic Acceptance、TUI autopilot、Project Control 以及对应测试。
- 当前不是对已发布主线做静态分析，而是对一轮正在进行的 Execution OS 改造做增量设计。

## 2. 已发现的关键结构问题

### 2.1 `checkpoint-supervisor-loop` 只完成“感知”，未完成“控制”

当前流程实际是：

```text
poll
 -> triggerPolicy.evaluate
 -> evidenceCollector.collect
 -> checkpointStore.createCheckpoint
 -> acceptanceService.evaluateCheckpoint
 -> updateRun(checkpoint ids)
 -> return action
```

缺少：

```text
persist review request
 -> ChatGPT review
 -> persist decision
 -> claim durable command
 -> execute action
 -> record result
```

因此注释中的“execute action”尚未落地。

### 2.2 checkpoint 重复创建

`checkpoint-supervisor-loop.tick()` 已经执行 trigger、collect、create checkpoint；随后调用 `checkpoint-acceptance-service.evaluateCheckpoint()`，后者再次执行 trigger、collect、create checkpoint。

可能后果：

- 一轮 tick 产生两个 checkpoint。
- verdict 关联的 checkpoint 与 loop 返回的 checkpoint 不一致。
- `checkpoint_ids` 重复或顺序异常。
- 定时任务幂等键无法稳定建立。

必须收敛为：

```text
CheckpointOrchestrator
  只创建一次 checkpoint
  -> ReviewRequestService
  -> DecisionService
  -> CommandService
```

### 2.3 当前“判断”仍是规则映射

`checkpoint-acceptance-service.decideAction()` 当前大致按以下规则工作：

```text
no_progress/tui_idle -> send_correction/takeover
 git_diff             -> continue_codex
 test_completed        -> continue_codex
 interval              -> continue_codex
```

这无法识别：

- 新增第二套状态主权。
- 绕过 Canonical Acceptance。
- 通过兼容层保留双执行链。
- 测试全部通过但架构方向变差。
- 解决症状而非根因。
- 修改范围表面合理但违反既定产品原则。

因此 `decideAction()` 不应继续承担方向判断，只应负责 fallback 和系统异常处理。

### 2.4 `supervisor-policy-engine` 不是 Chief Architect

它适合做：

- correction budget。
- takeover budget。
- repeated failure 升级。
- 未知 verdict 的保守处理。

它不适合做：

- 判断实现是否违背架构方向。
- 判断某个新 Store 是否属于重复状态主权。
- 判断某种兼容逻辑是否会阻碍产品化。

目标改名建议：

```text
supervisor-policy-engine.mjs
  -> supervisor-action-guard.mjs
```

或者保留文件名，但明确其职责为 action guard，不是 semantic reviewer。

### 2.5 takeover 只有状态，没有完整 ownership protocol

当前 `supervisor-takeover-service` 会将 Run 转为 `chatgpt_direct`，但仍缺：

- 请求 Codex quiesce。
- 确认 PTY 不再输入。
- 确认子进程不再写文件。
- 释放或转移 worktree lease。
- 记录 takeover base SHA、dirty paths、session cursor。
- ChatGPT 完成后生成 handoff artifact。
- 交还时恢复 Codex session 或创建同 Run 新 Attempt。

## 3. 目标职责分层

```text
Scheduled Trigger
  只负责定期调用，不存业务状态

Supervisor Review Coordinator
  列举活跃 Run、构建 review request、等待决策

Review Packet Builder
  收集 Goal、Plan、方向文档、diff、tests、TUI progress、history

ChatGPT Semantic Reviewer
  判断方向是否偏离并输出结构化 Decision

Action Guard
  校验预算、ownership、revision、session、前置条件

Durable Command Store
  保存 correction/resume/pause/takeover 命令并保证幂等

Action Executor
  对同一 TUI、同一 Run、同一 worktree 执行动作

Projection/Reconciler
  投影 Run/Task/TUI/controller 状态并修复不一致
```

## 4. 单一主流程

```text
review_active_runs()
  -> select reviewable runs
  -> build ReviewRevision
  -> get-or-create ReviewRequest
  -> return packets to ChatGPT

ChatGPT
  -> submit SupervisorDecision

submit_decision()
  -> validate decision schema
  -> verify review revision still current
  -> create idempotent SupervisorCommand
  -> ActionExecutor claim command
  -> acquire controller lease
  -> execute
  -> observe acknowledgement/progress
  -> mark command applied/failed
  -> project run state
```

## 5. 文件迁移地图

### 保留并强化

- `execution-core/execution-run-schema.mjs`
- `execution-core/execution-run-store.mjs`
- `supervisor/supervisor-checkpoint-store.mjs`
- `supervisor/supervisor-plan-store.mjs`
- `supervisor/supervisor-takeover-service.mjs`
- `dynamic-acceptance/checkpoint-evidence-collector.mjs`
- `tool-groups/project-control/*`

### 重构

- `execution-core/checkpoint-supervisor-loop.mjs`
  - 变成 review coordinator，不再自行完成两套 checkpoint 流程。
- `dynamic-acceptance/checkpoint-acceptance-service.mjs`
  - 去掉触发、采证、建 checkpoint；只保留 evidence-level deterministic acceptance，或迁移为 compatibility facade。
- `supervisor/supervisor-policy-engine.mjs`
  - 只做预算与安全 guard。
- `dynamic-acceptance/checkpoint-correction-builder.mjs`
  - 接受 ChatGPT decision，不再从 missing items 猜方向。

### 新增

```text
backend/src/supervisor-review/
  supervisor-review-revision.mjs
  supervisor-review-packet-schema.mjs
  supervisor-review-packet-builder.mjs
  supervisor-review-request-store.mjs
  supervisor-decision-schema.mjs
  supervisor-decision-store.mjs
  supervisor-command-schema.mjs
  supervisor-command-store.mjs
  supervisor-command-executor.mjs
  supervisor-controller-lease.mjs
  supervisor-review-service.mjs
  supervisor-review-reconciler.mjs
```

## 6. 不建议的替代方案

### 方案 A：继续增强规则引擎

优点：实现快。

缺点：无法识别方向漂移，已经被实际经验否定。

### 方案 B：每次都让 ChatGPT读取全仓库

优点：信息完整。

缺点：慢、昂贵、revision 不稳定、难以定时运行。

### 推荐方案 C：结构化事实包 + ChatGPT 语义判断 + durable command

优点：

- 保留 ChatGPT 的架构判断能力。
- 将运行控制和模型判断解耦。
- 可幂等、可恢复、可审计。
- 可与 ChatGPT 定时任务自然结合。

## 7. Phase 00 验收

Phase 00 本身只冻结语义，不接入写动作。

必须完成：

- 明确唯一 review revision 算法。
- 明确 controller ownership 状态机。
- 明确 ReviewRequest/Decision/Command 三种对象边界。
- 明确旧 checkpoint acceptance 的迁移路径。
- 建立目录和 schema tests。

不得完成：

- 不得直接由 interval trigger 向 TUI 发消息。
- 不得在没有 command store 的情况下接入定时任务。
- 不得通过自然语言日志判断 command 是否已执行。
