# Project / Goal / Task / Session：Human-Readable Design

> 文档状态：初稿  
> 参考代码基线：当前 main 
> 最后更新：2026-07-18  
> 阅读对象：任何需要理解 GPT-Codex Workspace 核心生命周期的人

## 关于本文档

本文档用自然语言描述 GPT-Codex Workspace 的核心抽象——Project / Goal / Task / Session——及其生命周期。它不重复代码细节或每个函数的签名，而是提供一张概念地图，让你能快速理解：

- 用户的一条请求最终是如何变成 Codex 中的一个执行 Session 的
- Goal / Task / Session 分别负责什么、怎么串联
- 一个"系统监督者"（Supervisor）如何介入纠偏
- 系统的故障模式与恢复路径是什么

---

## 1. 核心抽象

### Project（项目）

Project 是整个系统的顶层边界。在物理上，它是一个 Git 仓库 + `.gptwork/` 元数据目录。

Project 不存为数据库中的一条记录——它由以下因素隐含定义：

- 工作区根目录（`workspaceRoot`）
- `.gptwork/` 目录下的所有持久状态
- 仓库注册表（`repo-registry.mjs`）中的仓库列表
- 运行时配置（`runtime.env`）

一个 Project 包含多个 Goal，但一次只执行一个 Task。

### Goal（目标）

Goal 是 ChatGPT 接收到用户请求后创建的结构化"工作订单"。每个 Goal 对应一个唯一 ID（`goal_<uuid>`）以及 `.gptwork/goals/<goal_id>/` 下的一组文件：

| 文件 | 用途 |
|------|------|
| `goal.md` | 人类可读的目标描述 |
| `payload.json` / `payload.base64` | ChatGPT 编码的原始请求 |
| `transcript.md` | 对话记录 |
| `codex.entry.md` | Codex 入口指示——告诉 Codex 要做什么 |
| `context.bundle.md` | 上下文摘要（供 Codex 深度查找前阅读） |
| `result.json` / `result.md` | Codex 执行结果 |
| `acceptance.contract.json` | 验收合约——定义"什么叫完成" |
| `evidence.bundle.json` | 执行证据捆绑包 |

Goal 在创建后加入队列（Goal Queue），等待被调度执行。

### Task（任务）

Task 是 Goal 从"排队等待"变为"正在执行"时的绑定。它把 Goal 的意图转化为一个可调度的工作单元，包括：

- 选择的执行 Provider（`codex_exec` 或 `codex_tui`）
- 分配的隔离 Worktree
- 执行生命周期（分配中 → 运行中 → 已完成/已失败）

Task 的核心职责是**隔离**：每个 Task 在自己的 Git Worktree 中执行，不影响主仓库或其他 Task。

### Session（会话）

Session 是 Task 在 Provider 上的**实际执行实例**。当 Provider 是 `codex_tui` 时，Session 代表一个正在运行的 Codex TUI 进程（PTY）。

Session 包含：

- PTY 进程（运行 Codex TUI）
- Session Store（记录状态、输出、证据）
- Native Session Binding（绑定到 Codex 的原生 MCP session）
- Autopilot Controller（自动驾驶——TUI 交互自动化）

Session 的生命周期与 Task 绑定，但 Task 可能因为 Resume 等原因产生多个 Session。

### ExecutionRun（执行运行）——统一状态机

ExecutionRun 是上述所有概念的**统一状态机**。它是 `execution-core/` 引入的核心模型，把所有抽象连接在一起：

```
ExecutionRun
  ├── intent_id → ExecutionIntent（初始请求）
  ├── goal_id → Goal（工作订单）
  ├── task_id → Task（工作单元）
  ├── plan_id → SupervisorPlan（监督计划）
  ├── controller_owner（谁在控制？）
  ├── state（运行状态）
  ├── attempts[]（执行尝试历史）
  ├── checkpoints[]（监督检查点）
  └── evidence_bundle（收集的证据）
```

一个 Run 贯穿 Goal → Task → Session 的全过程，确保所有系统看到的都是同一个状态。

---

## 2. 完整生命周期

### 2.1 发起阶段

```
User Request
    │
    ▼
ChatGPT 预览 + 编码
    │
    ▼
create_encoded_goal(assign_to_codex=true)
    │
    ▼
[GPTWork Backend]
  - 写入 .gptwork/goals/<goal_id>/ 文件
  - 创建 Goal Record（status=open）
  - 生成 Context Bundle
    │
    ▼
enqueue_goal()
  - 加入 Goal Queue（status=waiting）
  - 自动检查依赖 / 仓库锁 / 工作区状态
    │
    ▼
auto_start=true 且条件满足
  - queue 状态 → ready → running
  - 创建 Task（assignee=codex, status=assigned）
```

### 2.2 执行阶段

```
Codex Worker 拾取 Task
    │
    ▼
创建 ExecutionRun（state=created → planning → ready）
    │
    ▼
选择 Provider
  - codex_exec（自动化模式，默认）
  - codex_tui（TUI 模式，显式指定或自动回退时）
    │
    ▼
Provider 启动
  - 分配 Worktree
  - 创建 Session（如果 provider=codex_tui）
  - 执行 Codex 入口点
    │
    ▼
Provider 观察 + 证据收集
  - 持续 observe 直到 termination 或 evidence_ready
  - 构建 Evidence Bundle
    │
    ▼
状态迁移
  running → collecting → evaluating
```

### 2.3 验收与完成阶段

```
ExecutionRun 进入 evaluating
    │
    ▼
AcceptanceService.evaluate()
  - 检查证据是否满足验收合约
  - 返回 AcceptanceDecision
    │
    ▼
根据决策：
  ✅ completed → 投影到 Task/Goal → 更新状态
  ⏳ waiting_for_integration → 尝试 ff-only merge
  🔧 waiting_for_repair → 自动创建修复 Task
  👁 waiting_for_review → ChatGPT 人工审查
  👤 waiting_for_supervisor → Supervisor 介入
    │
    ▼
最终写回（Task Final Writeback）
  - 更新 result.json / result.md
  - 更新 Task 状态
  - 触发 Queue Auto-Advance
```

### 2.4 监督与纠偏（Supervisor）

系统的 Supervisor Review 机制允许 ChatGPT 在 Codex 执行过程中**主动审查并纠偏**。

```
Codex 执行中
    │
    ▼
CheckpointSupervisorLoop（定时 tick）
  - 评估 TriggerPolicy（是否到达检查点时机？）
  - 收集 Evidence Snapshot
  - 创建单一 Checkpoint
  - 通知 ReviewCoordinator
    │
    ▼
ReviewCoordinator 构建 ReviewPacket
  - 包含：Goal / Plan / 架构约束 / Diff 摘要 / 测试结果 / 进展
  - 提交到 ReviewRequestStore
    │
    ▼
ChatGPT 通过 MCP 工具查看
  - supervisor_review_active_runs → 查看活跃运行列表
  - supervisor_get_review_packet → 获取完整审查包
    │
    ▼
ChatGPT 提交 Decision
  - 发送 correction（纠偏指令）
  - pause_codex（暂停）
  - chatgpt_takeover（接管）
  - handoff_to_codex（交还）
    │
    ▼
Command Store → Review Worker → Command Executor
  - claim command → execute command → 更新 Run 状态
```

### 2.5 接管与恢复（Takeover / Resume）

```
ChatGPT Takeover
  - controller_owner → chatgpt_direct
  - ChatGPT 直接操作同一 Worktree、分支、Git 状态
  - 不创建 Repair Task，不切新 Worktree
    │
    ▼
ChatGPT Handoff
  - handoff_to_codex command
  - Handoff Service 执行交还
  - controller_owner → workmcp_autopilot
    │
    ▼
Native Resume
  - Session 丢失后恢复
  - resume_and_send_correction 命令
  - 自动绑定新的 Native Session
  - 继续执行纠偏后的指令
```

---

## 3. 状态模型

### 3.1 ExecutionRun 状态图

```
created ──→ planning ──→ ready ──→ running ──→ collecting ──→ evaluating
  │                                                    │
  └──→ cancelled                                       │
               ┌────────────────────────────────────────┘
               ▼
      ┌──────────────────────────────────────────────────┐
      │                                                  │
      ▼                                                  ▼
  completed                                     waiting_for_repair
  failed                                        waiting_for_review
  cancelled                                      waiting_for_supervisor
                                                 waiting_for_integration
                                                      chatgpt_direct
```

### 3.2 Controller Owner 枚举

谁在控制执行方向：

| Owner | 含义 |
|-------|------|
| `workmcp_autopilot` | GPTWork 自动执行（默认） |
| `chatgpt_supervising` | ChatGPT 正在监督（定时审查） |
| `chatgpt_direct` | ChatGPT 已接管（直接操作） |
| `waiting_for_chatgpt` | 等待 ChatGPT 做决定 |

### 3.3 Session 状态

Codex TUI Session 的独立状态机：

```
created → starting → running → completed
                              → failed
                              → timed_out
                              → stopped
                              → cancelled
```

---

## 4. 关键设计决策

### 4.1 ExecutionRun 是唯一真相源

不创建独立的 `SupervisorRun`、`CheckpointRun` 或其他并行状态机。所有执行状态（包括监督、纠偏、验收）全部挂在 `ExecutionRun` 上。

### 4.2 Provider 不决定完成

Provider（codex_exec / codex_tui）只能：启动、观察、停止、收集原始证据。

Provider 不能决定 Run / Task / Goal 是否完成。完成必须经过：

```
Evidence → AcceptanceDecision → Canonical Decision → Progression
```

### 4.3 单一 Checkpoint 主权

`CheckpointSupervisorLoop` 是唯一的 Checkpoint 创建者：

1. 构建一个 Evidence Snapshot
2. 创建一个 Checkpoint
3. `ReviewCoordinator.requestReview(checkpointContext)`
4. `AcceptanceProjector.project(checkpointContext)`（确定性投影）

`acceptanceService.evaluateCheckpoint()` 不能再次触发、收集或创建 Checkpoint。

### 4.4 ChatGPT Decision = 监督权威

当 ChatGPT 提交 Decision 时，它的判断高于任何确定性验收规则。

```
ChatGPT Decision = supervisory authority
Deterministic Acceptance = evidence/facts provider
```

两者不是平级决策引擎。

### 4.5 原生 codex_tui 是默认 Provider

`codex_exec` 是显式兼容路径，不是自动回退目标。新的执行默认使用原生 Codex TUI。

### 4.6 所有持久状态必须幂等

Run、Event、Attempt、Checkpoint、Pending Effect 和终态副作用必须是：

- 持久化（写入 Store 后即使进程崩溃也不丢失）
- 幂等（重复执行不产生重复效果）
- 可重放（从 Store 可以重建当前状态）

---

## 5. 故障模式与恢复

| 故障 | 影响 | 恢复策略 |
|------|------|----------|
| Session 进程崩溃 | 执行中断 | Native Resume Service → 自动恢复 Session |
| ChatGPT 超时未响应 | 监督循环停等 | 超时 → 自动回退到确定性验收 |
| Provider 启动失败 | Run 无法开始 | 切换 Provider（codex_exec ↔ codex_tui） |
| Checkpoint 创建失败 | 无法触发监督 | Review Request Store 持久重试 |
| Command 执行失败 | 纠偏指令无效 | Command Store 允许重新 claim + 重试 |
| Worktree 冲突 | 多个 Task 互相影响 | Repo Lock + 串行执行 |
| 验收合约不满足 | Task 标记为 failed | 自动创建 Repair Task |
| Integration merge 冲突 | 无法自动合并 | 标记 waiting_for_integration，人工处理 |

---

## 6. 与其他系统的关系

```
                     ┌─────────────┐
                     │   ChatGPT   │
                     │  (Supervisor)│
                     └──────┬──────┘
                            │ MCP
                     ┌──────▼──────┐
                     │  gptwork-   │
                     │  server     │
                     │  (MCP)      │
                     └──────┬──────┘
                            │ HTTP/JSON-RPC
              ┌─────────────┼─────────────┐
              │             │             │
       ┌──────▼─────┐ ┌────▼────┐ ┌─────▼──────┐
       │  State     │ │  Goal   │ │  Codex     │
       │  Store     │ │  Queue  │ │  Worker    │
       └────────────┘ └─────────┘ └─────┬──────┘
                                        │ spawn
                                  ┌─────▼──────┐
                                  │  Codex TUI │
                                  │  (Session) │
                                  └────────────┘
```

### 核心接口

- **ChatGPT → GPTWork**: MCP tools（`create_encoded_goal`, `supervisor_review_active_runs`, `supervisor_submit_decisions`）
- **GPTWork → Codex**: Worker 进程管理（`codex tui` / `codex exec`）
- **GPTWork ↔ Store**: 状态持久化（JSON 文件 / LevelDB）
- **GPTWork ← Session**: PTY 输出 + Result Artifact 检测

---

## 7. 路线图（从 01.md 出发）

`01.md` 评估了系统中的 P0/P1 问题。以下是从当前状态到"完全可运行"的剩余工作：

### 已修复（01.md 第五节）

- ✅ Supervisor Review 工具接入主工具注册表
- ✅ Review Worker 接入后台 Runtime
- ✅ Checkpoint 单一主权（消除重复创建）
- ✅ Supervisor loop start/stop 生命周期修复
- ✅ Native Resume 接入 Command Executor
- ✅ Handoff Service 进入 Command Executor
- ✅ planStore.readPlan(null) 修复
- ✅ Review Coordinator 替换旧 Acceptance
- ✅ supervisor_review_active_runs 枚举修复
- ✅ 工具返回内容增强（Review Packet Builder）

### 仍需验证/修复的

- ⏳ P0 工具注册的集成测试覆盖
- ⏳ Review Worker 在生产 Composition 中的真实启动验证
- ⏳ Resume + Handoff 的端到端测试
- ⏳ 所有 supervisor-review 测试绿（当前有 checkpoint-supervisor-loop start/stop 失败——已修复但需验证）
- ⏳ 原生 Codex TUI 完整流程 Canary（从 Goal 创建到 Completion）
