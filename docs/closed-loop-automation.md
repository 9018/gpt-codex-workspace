# 自动验收推进闭环设计

> Goal → Task → Agent执行 → Evidence收集 → Acceptance验证 → Replan/Continue/Stop

**状态**: 当前交付  
**最后更新**: 2026-07-10  
**对本项目产品化意义**: 建立可观测、可验收、可纠偏的最小闭环，实现"编、验、判"一体化

---

## 目录

1. [闭环概述](#1-闭环概述)
2. [状态机与闭环节点](#2-状态机与闭环节点)
3. [验收标准字段与执行结果记录](#3-验收标准字段与执行结果记录)
4. [判据逻辑：Replan / Continue / Stop](#4-判据逻辑replan--continue--stop)
5. [如何运行](#5-如何运行)
6. [如何验收](#6-如何验收)
7. [距离产品化的差距分析](#7-距离产品化的差距分析)
8. [参考架构借鉴](#8-参考架构借鉴)
9. [模块映射与下一步](#9-模块映射与下一步)

---

## 1. 闭环概述

### 核心闭环

```
  ┌──────────────────────────────────────────────────────────────┐
  │                         Operator                              │
  │  (ChatGPT / Codex CLI / TUI)                                  │
  └──────────┬──────────────┬──────────────┬──────────────────────┘
             │              │              │
             ▼              │              │
  ┌──────────────────┐      │              │
  │  1. Goal/任务定义 │      │              │
  │  验收标准/计划    │──────│──────────────│────────────────┐
  └────────┬─────────┘      │              │                │
           │                │              │                │
           ▼                │              │                │
  ┌──────────────────┐      │              │                │
  │  2. Task调度     │      │              │                │
  │  队列/锁/工作树  │      │              │                │
  └────────┬─────────┘      │              │                │
           │                │              │                │
           ▼                │              │                │
  ┌──────────────────┐      │              │                │
  │ 3. Agent执行     │◄─────│──────────────│────────────────│
  │  worktree/codex  │      │              │                │
  └────────┬─────────┘      │              │                │
           │ result.json    │              │                │
           ▼                │              │                │
  ┌──────────────────┐      │              │                │
  │ 4. Evidence收集  │      │              │                │
  │ 验证/报告/证据   │      │              │                │
  └────────┬─────────┘      │              │                │
           │                │              │                │
           ▼                │              │                │
  ┌──────────────────┐      │              │                │
  │ 5. Acceptance验  │──────│──────────────│────────────────│
  │  合同/状态/门    │      │              │                │
  └────────┬─────────┘      │              │                │
           │                │              │                │
           ▼                ▼              ▼                │
  ┌────────┴─────────┐                                       │
  │  6. 三叉决策       │                                      │
  │                   │                                      │
  │  ● Replan ───→ 修复/重试                                  │
  │  ● Continue ──→ 推进(完成/下一项)                          │
  │  ● Stop ──────→ 升级人工                                   │
  │                   │                                      │
  └────────┬─────────┘                                      │
           │                                                  │
           ├── Replan(repair/retry) ────────→ 回到 3/4 阶段     │
           ├── Continue(auto_complete) ────→ 目标推进队列       │
           └── Stop(requires_review) ──────→ 人工介入审查       │
                            ↑                                  │
                            └──────────────────────────────────┘
```

### 设计原则

1. **合同驱动**: 每个任务附带 `acceptance.contract.json`，明确声明验收标准
2. **证据分离**: Git commit、verification commands、acceptance verdict 各自独立记录
3. **判据透明**: 闭环节点产生 `unified_decision`，包含全部 blocker/followup/quality 证据
4. **自动优先**: 所有可自动判定的情况优先自动推进，仅歧义/失败升级给人工
5. **最小逆改**: 每次闭环优先选择最小可逆变更，不引入大规模框架依赖

---

## 2. 状态机与闭环节点

### 完整状态机

```
                    ┌──────────────┐
                    │   assigned   │
                    └──────┬───────┘
                           │ queue advances
                           ▼
                    ┌──────────────┐
              ┌─────│   queued     │
              │     └──────┬───────┘
              │            │ worker picks up
              │            ▼
              │     ┌──────────────┐
              │     │   running    │
              │     └──────┬───────┘
              │            │ result produced
              │            ▼
              │     ┌──────────────────┐
              │     │  acceptance_gate │────→ verification.json/acceptance.json
              │     └──────┬───────────┘
              │            │
              │            ▼
              │     ┌─────────────────────────────┐
              │     │      闭环节点判定              │
              │     │  (task-closure-decider)       │
              │     │  + (task-finalizer)           │
              │     └──────────┬──────────────────┘
              │                │
              │    ┌───────────┼─────────────┐
              │    │           │             │
              ▼    ▼           ▼             ▼
     ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
     │ waiting_for │ │ waiting_for │ │ completed   │
     │ _repair     │ │ _review     │ │             │
     │             │ │             │ │             │
     │ ● Replan    │ │ ● Stop      │ │ ● Continue  │
     │             │ │             │ │             │
     └──────┬──────┘ └─────────────┘ └──────┬──────┘
            │                               │
            └─────→ back to running ────────→ queue auto-advance
                   (repair budget允许时)
```

### 节点说明

| 节点 | 模块 | 关键产出 |
|---|---|---|
| **1. Goal/任务定义** | `goal-task-*.mjs` | `goal.md`, `codex.entry.md`, `acceptance.contract.json` |
| **2. Task调度** | `goal-queue.mjs`, `task-worktree-manager.mjs` | queue item, worktree branch |
| **3. Agent执行** | `codex-worker-loop.mjs`, `codex-execution-provider.mjs` | `result.json`, git commit |
| **4. Evidence收集** | `verification-report.mjs`, `delivery-result-recovery.mjs` | `verification.json`, recovery evidence |
| **5. Acceptance验证** | `acceptance-gate-engine.mjs`, `contract-verifier.mjs` | `acceptance.json` |
| **6. 三叉决策** | `task-closure-decider.mjs`, `task-finalizer.mjs`, `codex-unified-decision.mjs` | `unified_decision` |

---

## 3. 验收标准字段与执行结果记录

### 3.1 验收合同字段 (`acceptance.contract.json`)

完整字段定义见 `contract-schema.mjs`，以下为核心字段：

| 字段路径 | 必填 | 类型 | 说明 | 示例 |
|---|---|---|---|---|
| `schema_version` | 是 | number | 合同版本 | `1` |
| `intent.operation_kind` | 是 | string | 操作类型 | `"code_change"`, `"docs_only"`, `"restart"` |
| `intent.mutation_scope` | 是 | string | 变更域 | `"repo"`, `"runtime"`, `"none"` |
| `intent.execution_mode` | 是 | string | 执行模式 | `"worktree"`, `"canonical"` |
| `intent.semantic_confidence` | 是 | string | 语义置信度 | `"high"`, `"medium"`, `"low"` |
| `requirements.requires_commit` | 否 | bool | 是否需要commit | `true` |
| `requirements.requires_integration` | 否 | bool | 是否需要集成 | `true` |
| `requirements.requires_deployment_check` | 否 | bool | 是否需要部署检查 | `false` |
| `requirements.requires_restart` | 否 | bool | 是否需要重启 | `false` |
| `blocking_requirements[].id` | 否 | string | 阻塞项ID | `"commit_present"` |
| `blocking_requirements[].description` | 否 | string | 阻塞项描述 | `"A commit hash must exist"` |
| `blocking_requirements[].evidence` | 否 | string[] | 证据路径 | `["commit"]` |
| `verification_plan.profile` | 否 | string | 验证计划 | `"code_change"`, `"docs"`, `"fast"` |
| `completion_policy.auto_complete_when_blocking_requirements_pass` | 否 | bool | block通过即自动完成 | `true` |
| `completion_policy.allow_completed_with_followups` | 否 | bool | 允许携带followup完成 | `true` |
| `state_assertions[].id` | 否 | string | 状态断言ID | `"no_dirty_worktree"` |
| `acceptance_criteria` | 否 | string[] | 验收标准自然语言描述 | `["代码通过语法检查", ...]` |
| `review_policy.requires_review_when` | 否 | string[] | 触发review的条件列表 | `["semantic_ambiguity"]` |

### 3.2 执行结果字段 (`result.json`)

| 字段路径 | 必填 | 类型 | 说明 | 示例 |
|---|---|---|---|---|
| `status` | 是 | string | 执行状态 | `"completed"`, `"failed"` |
| `summary` | 是 | string | 执行摘要 | `"Added closed-loop automation docs"` |
| `changed_files` | 否 | string[] | 变更文件列表 | `["docs/closed-loop.md"]` |
| `commit` | 否 | string | git commit hash | `"a1b2c3d..."` |
| `verification.passed` | 否 | bool | 验证是否通过 | `true` |
| `verification.commands` | 否 | array | 验证命令及结果 | `[{cmd, exit_code, ...}]` |
| `verification.findings` | 否 | array | 验证发现 | `[{severity, code, message}]` |
| `acceptance_contract` | 否 | object | 内联验收合同 | `{schema_version: 1, ...}` |
| `tests` | 否 | string | 测试结果描述 | `"All 208 tests pass"` |
| `followups` | 否 | array | 后续任务建议 | `["Add integration E2E test"]` |
| `warnings` | 否 | array | 警告 | `["No test suite discovered"]` |
| `integration.status` | 否 | string | 集成状态 | `"merged"`, `"skipped"` |
| `integration.satisfied` | 否 | bool | 集成是否满足 | `true` |

### 3.3 验收门产出 (`acceptance.json`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `"passed"`, `"failed"`, `"needs_action"` |
| `passed` | bool | 门是否通过 |
| `task_status` | string | 映射后的task状态 |
| `reason` | string | 判定原因码 |
| `closure_decision.status` | string | 闭环节点状态 |
| `closure_decision.blocking_passed` | bool | blocking要求是否通过 |
| `closure_decision.auto_complete_allowed` | bool | 是否允许自动完成 |
| `closure_decision.requires_human_decision` | bool | 是否需要人工判据 |
| `findings` | array | 所有发现的汇总 |

### 3.4 统一决策产出 (`unified_decision`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | 终端/非终端状态 |
| `reason` | string | 可读的判定原因 |
| `closure_reason` | string | 结构化的决因码 |
| `profile` | string | 验收档案 |
| `blocking_passed` | bool | 无blocker/major发现 |
| `requires_review` | bool | 需要人工审查 |
| `requires_repair` | bool | 需要自动修复 |
| `requires_integration` | bool | 集成未完成 |
| `safe_to_auto_advance` | bool | 队列可自动推进 |
| `blockers` | array | 阻塞级发现 |
| `repairable_blockers` | array | 可自动修复的阻塞 |
| `non_blocking_followups` | array | 不阻塞的后续项 |
| `quality_notes` | array | 质量备注 |

---

## 4. 判据逻辑：Replan / Continue / Stop

### 闭环节点决策树

```
result.json
    │
    ├── status === "completed"
    │       │
    │       ├── verification.passed === true
    │       │       │
    │       │       ├── contract blocking passed
    │       │       │       │
    │       │       │       ├── integration satisfied (或不需要)
    │       │       │       │       │
    │       │       │       │       ├── ✅ Continue
    │       │       │       │       │    auto_completed_clean /
    │       │       │       │       │    auto_completed_with_followups
    │       │       │       │       │    → task status = completed
    │       │       │       │       │    → safe_to_auto_advance = true
    │       │       │       │       │    → 队列推进下一项
    │       │       │       │       │
    │       │       │       │       └── ❌ integration 未完成
    │       │       │       │            waiting_for_integration
    │       │       │       │            → 继续等待集成(非终端)
    │       │       │       │
    │       │       │       └── contract blocking 未通过
    │       │       │               │
    │       │       │               ├── 可修复
    │       │       │               │    → 🔄 Replan (waiting_for_repair)
    │       │       │               │    → 修复循环 (repair budget 内)
    │       │       │               │
    │       │       │               └── 不可修复
    │       │       │                    → 🛑 Stop (requires_review)
    │       │       │                    → 人工审查升级
    │       │       │
    │       │       └── verification.passed === false
    │       │               → 🔄 Replan (waiting_for_repair)
    │       │                 或 🛑 Stop (requires_review, 配置决定)
    │       │
    │       └── status !== "completed" (failed/timed_out)
    │               → 不可恢复 → 🛑 Stop (failed 终端)
    │
    └── (其他情况)
            → 🛑 Stop (requires_review)
```

### 六种闭环节点判定源码引用

| 决策结果 | 对应状态 | 源码位置 | 说明 |
|---|---|---|---|
| ✅ **Continue** (auto_completed_clean) | `completed` | `closure/task-closure-decider.mjs:194-196` | 所有gates通过，无followup |
| ✅ **Continue** (auto_completed_with_followups) | `completed` | `closure/task-closure-decider.mjs:196` | 同上但带followup |
| 🔄 **Replan** (waiting_for_repair) | `waiting_for_repair` | `closure/task-closure-decider.mjs:105-110` | verification失败、可修复 |
| 🔄 **Replan** (waiting_for_integration) | `waiting_for_integration` | `closure/task-closure-decider.mjs:126-141` | 集成未完成(非终端) |
| 🛑 **Stop** (requires_review) | `waiting_for_review` | `closure/task-closure-decider.mjs:89-97,113-121` | 不可修复、歧义、安全 |
| 🛑 **Stop** (failed) | `failed` | `closure/task-closure-decider.mjs:160-165` | 终端失败 |

### 修复循环 (Replan Loop)

```
  waiting_for_repair
       │
       ├── repair budget 内
       │       │
       │       ├── 自动修复 → re-run
       │       │    (task-retry.mjs / repair-loop.mjs)
       │       │
       │       └── 手动分配新 task 修复
       │
       ├── repair budget 耗尽
       │       → 🛑 Stop (requires_review)
       │
       └── 配置为 verificationFailureRequiresReview
               → 🛑 Stop (requires_review)
```

---

## 5. 如何运行

### 5.1 启动服务

```bash
cd backend

# 快速启动(本地开发)
npm start

# 生产启动(启用 Codex worker)
GPTWORK_CODEX_WORKER=true node src/cli.mjs
```

### 5.2 创建一个带验收合同的任务

```bash
gptwork create-task \
  --title "添加 E2E 测试" \
  --description "为验收闭环添加集成测试" \
  --acceptance-contract '{
    "intent": { "operation_kind": "code_change", "mutation_scope": "repo" },
    "requirements": { "requires_commit": true, "requires_integration": true },
    "verification_plan": { "profile": "code_change" }
  }'
```

### 5.3 手动触发验收门

```bash
node src/cli.mjs accept --task-id <task_id>
# 或通过 MCP 工具:
# invoke accept_task task_id=<task_id>
```

### 5.4 查看验收结果

```bash
# 查看验收门产出
cat .gptwork/goals/<goal_id>/acceptance.json

# 查看验证报告
cat .gptwork/goals/<goal_id>/verification.json

# 查看统一决策
cat .gptwork/goals/<goal_id>/result.json | jq '.unified_decision'
```

### 5.5 手动处理 review/repair 状态

```bash
# 查看 review 包
gptwork review --task-id <task_id>

# 手动推进任务(override auto-closure)
gptwork advance-task --task-id <task_id> --status completed
```

---

## 6. 如何验收

### 6.1 验收流程

```
1. 检查 acceptance.json → status === "passed"
       │
2. 确认 verification.json → passed === true, findings 无 blocker
       │
3. 确认 closure_decision → blocking_passed === true
       │
4. 确认 integration → satisfied === true (或未要求)
       │
5. 确认非阻塞项已记录为 followup
       │
6. 人工检查 changed_files 符合预期
       │
7. 运行完整 release gate 验证
       │
8. ✅ 验收通过
```

### 6.2 验收命令

```bash
# Release gate - 完整的交付验证
cd backend && npm run release:check

# E2E 验收套件
cd backend && npm run test:e2e-acceptance

# 语法 & 导入检查
cd backend && npm run check:syntax && npm run check:imports

# 诊断
gptwork doctor --local
```

### 6.3 验收检查清单

- [ ] `acceptance.json: status === "passed"`
- [ ] `verification.json: passed === true`
- [ ] `closure_decision.blocking_passed === true`
- [ ] 所有 `blocker` 级别 finding 已修复或升级
- [ ] integration 已完成 (merged/skipped/not_required)
- [ ] `changed_files` 列表合理且完整
- [ ] `commit` 存在且可在 canonical main 上访问
- [ ] `followups` 已记录 (非阻塞)
- [ ] 无脏工作树 (git diff --check 通过)
- [ ] Release gate 通过 (npm run release:check)

---

## 7. 距离产品化的差距分析

### 已产品化的能力

| 能力 | 状态 | 证据 |
|---|---|---|
| Goal-Task 生命周期 | ✅ 完整 | `goal-lifecycle.mjs`, `goal-task-*.mjs` |
| 工作树隔离 | ✅ 完整 | `task-worktree-manager.mjs`, `goal-worktree-service.mjs` |
| 队列调度与推进 | ✅ 完整 | `goal-queue.mjs`, `queue-policy.mjs` |
| Codex Agent 执行 | ✅ 完整 | `codex-worker-loop.mjs`, `codex-execution-provider.mjs` |
| 验收合同机制 | ✅ 完整 | `contract-schema.mjs`, `acceptance-contract-service.mjs` |
| 证据收集与规范化 | ✅ 完整 | `evidence-normalizer.mjs`, `verification-report.mjs` |
| 验收门引擎 | ✅ 完整 | `acceptance-gate-engine.mjs` |
| 闭环节点判定 | ✅ 完整 | `task-closure-decider.mjs` |
| 统一决策产出 | ✅ 完整 | `codex-unified-decision.mjs` |
| 最终化判定 | ✅ 完整 | `task-finalizer.mjs` |
| 自动集成 (ff-only) | ✅ 完整 | `auto-integration-completion.mjs` |
| 交付结果恢复 | ✅ 完整 | `delivery-result-recovery.mjs` |
| Release gate | ✅ 完整 | `scripts/release-delivery-check.mjs` |
| 人工审查包 | ✅ 完整 | `review-packet-builder.mjs` |
| 状态断言 | ✅ 完整 | `state-assertion-runner.mjs` |

### 产品化差距清单

| # | 差距 | 严重程度 | 当前状态 | 优先级 |
|---|---|---|---|---|
| G01 | **无优雅关闭 in-flight Codex 子进程** | Low | 已知风险 R01 | P2 |
| G02 | **状态文件未分片，不支持并发写** | Low | 已知风险 R02 | P2 |
| G03 | **无自动日志轮转** | Low | 已知风险 R03 | P3 |
| G04 | **Bark 通知无重试/确认** | Low | 已知风险 R04 | P3 |
| G05 | **工作树无自动 GC** | Low | 已知风险 R05 | P2 |
| G06 | **MCP 服务无内置限流器** | Low | 已知风险 R06 | P3 |
| G07 | **上下文索引重建清除所有缓存** | Low | 已知风险 R07 | P3 |
| G08 | **Task 超时仅杀 worker 循环不杀 Codex 子进程** | Low | 已知风险 R08 | P2 |
| G09 | **无多节点状态复制** | Informational | 已知风险 R09 | P4 |
| G10 | **修复循环不跨重启持久化修复状态** | Low | 已知风险 R10 | P2 |
| G11 | **无多 Agent 并行执行** | Medium | 当前为串行 worker | P2 |
| G12 | **无 Agent 间 handoff 协议** | Medium | 单 Agent 模式 | P3 |
| G13 | **无 Webhook-driven 事件触发** | Medium | 只有轮询 | P2 |
| G14 | **无内置 Dashboard/UI** | Medium | 仅 MCP/CLI | P2 |
| G15 | **无用户级权限模型** | Medium | 仅简单 token auth | P3 |

### 产品化路线图

```
P0 (当前)            P1                  P2                  P3
│                    │                   │                   │
▼                    ▼                   ▼                   ▼
─────────────────────────────────────────────────────────────►
                                                           时间
│                    │                   │                   │
├ 闭环基础            ├ 运维强化           ├ 水平扩展           ├ 高级能力
│                     │                   │                   │
│ ● Goal→Task→       │ ● 优雅退出         │ ● 状态分片         │ ● 多Agent并行
│   Agent→Evidence→  │ ● 子进程隔离       │ ● 分布式锁         │ ● Agent Handoff
│   Accept→Decide    │ ● 工作树GC        │ ● 多节点复制       │ ● Webhook事件
│ ● 验收合同          │ ● 修复持久化       │                   │ ● Dashboard
│ ● 闭环节点判定       │ ● 限流器          │                   │ ● 权限模型
│ ● Release Gate     │ ● 日志轮转         │                   │
│ ● 统一决策          │ ● 通知重试         │                   │
│                     │                   │                   │
```

### 如何判断距离产品化

1. **P0 已交付**: 核心闭环的三个关键 artifact 均可通过 MCP 工具检出和验证
2. **差距清单 G01-G10 为已知 Low 风险**: 不影响核心流程正确性
3. **G11-G15 为能力扩展**: 不阻塞现有任务推进
4. **一个简单的判据**: 如果在无人值守下，连续 100 个任务(含 code_change, docs_only, restart, admin 类型) 全部自动通过验收门且仅产生 ≤5 个需要人工介入的 review 状态，则说明闭环基本产品化
5. **第二个判据**: 当差距 G01-G05 全部解决后，可标记为 P1 运维级产品化

---

## 8. 参考架构借鉴

### 8.1 Microsoft AutoGen / agent-framework

借鉴点:

| 模式 | AutoGen | 本项目实现 |
|---|---|---|
| **Planner/Agent/Critic** | 多 Agent 角色分工 | 单 Agent + acceptance gate 作为 critic |
| **Handoff 协议** | Agent 间消息路由 | Task → finalizer → queue 的单向推进 |
| **Termination 条件** | `TerminationCondition` 接口 | `task-closure-decider.mjs` 的闭环节点判定 |
| **Agent 团队** | GroupChat 管理 | 无（后续 P3 可引入） |

**迁移机制**: AutoGen 的 `termination` 模式直接对应本项目的 `closure-decider + finalizer` — 都从可观测证据中推导出是否终止。本项目的差异在于将 termination 收敛到一个确定性决策引擎而非多 Agent 协商。

### 8.2 SWE-agent / mini-swe-agent

借鉴点:

| 模式 | SWE-agent | 本项目实现 |
|---|---|---|
| **Agent 执行闭环** | Command → Observation → Thought → Action | Codex 执行 → result.json → verification → acceptance |
| **轻量代理** | 单 agent + bash + 文件编辑 | Codex worker + worktree + file mutations |
| **结果解析** | 结构化 stdout | `codex-result-parser.mjs` 家族 |
| **重试/恢复** | 多轮 attempt | `repair-loop.mjs` + `delivery-result-recovery.mjs` |

**迁移机制**: SWE-agent 的 `Command → Observation` 循环对应本项目的 `Codex execution → result.json parsing → evidence collection`。本项目的差异在于证据收集后通过 acceptance gate 做结构化判定而非 agent 自身判定。

### 8.3 RepoMaster / GitTaskBench

借鉴点:

| 模式 | RepoMaster / GitTaskBench | 本项目实现 |
|---|---|---|
| **仓库理解** | 依赖图/调用图分析 | `context-index/` 向量检索 + 工作树 |
| **验收基准** | Ground-truth patches | `acceptance.contract.json` + `contract-verifier.mjs` |
| **任务拆分** | 多步骤 pipeline | Goal → Task → sub-tasks (followup task planner) |

**迁移机制**: RepoMaster 的 "验收基准" 思想对应本项目的 `blocking_requirements` — 每个 requirement 对应一个可验证的证据断言。差异在于本项目验收基准由 operator (ChatGPT) 在 Goal 创建时设定而非预定义基准集。

### 8.4 对比总结

```
                    AutoGen          SWE-agent     RepoMaster      本项目
                    ───────          ─────────     ─────────       ──────
Agent 数量           Multi            Single        Single          Single*
Agent 协作            GroupChat        —             —               Gate-driven†
验收机制              Termination      Result parse  Diff match      Contract + Gate
决策引擎              协商             Embedded      Golden patch    Deterministic
重试/恢复             协商             Multi-attempt —               Repair loop
人工介入              Event-driven     默认需要      默认需要          Exception-only‡

* 并行多 Agent 为 P3 目标
† Acceptance gate 作为隐式"critic agent"
‡ 仅 requires_review 状态需要人工介入
```

---

## 9. 模块映射与下一步

### 模块映射

| 闭环阶段 | 核心模块 | 测试文件 |
|---|---|---|
| Goal/Task | `goal-task-*.mjs`, `goal-queue.mjs` | `test/goal-queue.test.mjs` |
| Agent执行 | `codex-worker-loop.mjs`, `codex-execution-provider.mjs` | `test/codex-worker-loop.test.mjs` |
| Evidence收集 | `verification-report.mjs`, `delivery-result-recovery.mjs` | `test/verification-report.test.mjs` |
| Acceptance验证 | `acceptance-gate-engine.mjs`, `contract-verifier.mjs` | `test/acceptance-policy.test.mjs` |
| Replan | `repair-loop.mjs`, `task-retry.mjs` | `test/task-retry.test.mjs` |
| Continue | `auto-integration-completion.mjs`, `goal-queue.mjs` | `test/auto-integration-completion.test.mjs` |
| Stop | `task-finalizer.mjs`, `codex-unified-decision.mjs` | `test/task-finalizer.test.mjs` |

### 下一步 TODO

| # | 任务 | 优先级 | 依赖 |
|---|---|---|---|
| 1 | 为所有闭环节点路径添加 E2E 验收测试 | **P1** | 无 |
| 2 | 在 acceptance.contract.json schema 中标准化 `acceptance_criteria` 字段 | **P1** | 无 |
| 3 | 为 `acceptance.json` 产出添加 `decision_tree_path` 字段标识判定路径 | **P1** | 无 |
| 4 | 实现 G01 (优雅关闭子进程) | **P2** | 无 |
| 5 | 实现 G05 (工作树自动 GC) | **P2** | 无 |
| 6 | 实现 G02 (状态分片) | **P2** | 架构设计先行 |
| 7 | 实现 G11 (多 Agent 并行) | **P3** | 状态分片完成 |
| 8 | 在 `project.md` 中标准化 closed-loop 运行指南 | **P1** | 本文档完成 |

---

## 附录 A：验收合同完整示例

```json
{
  "schema_version": 1,
  "intent": {
    "operation_kind": "code_change",
    "mutation_scope": "repo",
    "execution_mode": "worktree",
    "semantic_confidence": "high"
  },
  "requirements": {
    "requires_commit": true,
    "requires_integration": true,
    "requires_restart": false,
    "requires_deployment_check": false
  },
  "blocking_requirements": [
    {
      "id": "commit_present",
      "description": "A commit hash for the update is reported.",
      "evidence": ["commit"]
    },
    {
      "id": "changed_files_reported",
      "description": "Changed files are listed.",
      "evidence": ["changed_files"]
    },
    {
      "id": "verification_report",
      "description": "Verification commands passed.",
      "evidence": ["verification.passed"]
    },
    {
      "id": "integration_completed",
      "description": "Integration reached terminal state.",
      "evidence": ["integration.status"]
    }
  ],
  "verification_plan": {
    "profile": "code_change",
    "required_commands": ["npm test"],
    "required_reports": ["changed_files", "commit"],
    "report_must_match_head": true,
    "report_must_be_clean": true
  },
  "completion_policy": {
    "auto_complete_when_blocking_requirements_pass": true,
    "allow_completed_with_followups": true,
    "do_not_block_on_quality_notes": true
  },
  "review_policy": {
    "requires_review_when": ["semantic_ambiguity"]
  }
}
```

## 附录 B：验收门产出示例

```json
{
  "schema_version": 1,
  "status": "passed",
  "passed": true,
  "task_status": "completed",
  "reason": "blocking_gate_passed_clean",
  "timestamp": "2026-07-10T03:00:00.000Z",
  "task_id": "task_abc123",
  "goal_id": "goal_def456",
  "findings": [],
  "closure_decision": {
    "status": "auto_completed_clean",
    "reason": "blocking_gate_passed_clean",
    "blocking_passed": true,
    "auto_complete_allowed": true,
    "requires_human_decision": false,
    "task_status": "completed"
  }
}
```

---

*本文件描述了 GPTWork 自动验收推进闭环的整体设计与落地方案。优先做最小可逆变更，不引入大规模框架依赖。*
