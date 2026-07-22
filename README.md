# GPTWork

> 当前版本：2026-07-22，由 ChatGPT 直接维护。
>
> 让 ChatGPT 负责产品推进，让 Codex 负责执行。

GPTWork 是一个面向复杂软件项目的 AI 执行操作系统。

它不是一次性生成代码的工具，而是一套围绕 **目标、执行、证据、验收、修正、继续推进** 构建的闭环工作流。

```text
产品目标
   ↓
ChatGPT 分析与规划
   ↓
生成 Goal
   ↓
拆分 Task
   ↓
Codex 执行
   ↓
收集代码、命令、测试与 Git 证据
   ↓
ChatGPT 验收
   ↓
是否达到产品目标？
   ├─ 是 → 结束
   └─ 否 → 生成下一 Goal → 继续执行
```

---

## GPTWork 解决什么问题

普通 AI Coding 的工作方式通常是：

```text
用户提出需求
   ↓
AI 修改代码
   ↓
AI 声称完成
   ↓
用户自己检查
```

问题在于：

- 一次执行无法代表产品完成
- 修改代码和判断是否完成混在一起
- 缺少持续上下文
- 缺少可靠验收
- 失败后容易盲目重试
- 多任务并行时容易互相污染

GPTWork 将整个过程改造成：

```text
需求
  ↓
目标建模
  ↓
受控执行
  ↓
证据收集
  ↓
独立验收
  ↓
修正或推进
  ↓
产品完成
```

---

## 系统角色

```text
用户
  │
  └─ 提供产品目标与关键决策

ChatGPT
  ├─ 理解目标
  ├─ 制定 Goal
  ├─ 管理上下文
  ├─ 调度任务
  ├─ 审查执行结果
  ├─ 判断是否通过
  └─ 决定修正、继续或停止

Codex
  ├─ 阅读任务上下文
  ├─ 修改代码
  ├─ 执行命令
  ├─ 编写与运行测试
  ├─ 生成结构化结果
  └─ 返回可验收证据
```

核心原则：

```text
ChatGPT 负责决策
Codex 负责执行
证据负责证明
验收负责结束
```

---

## 完整执行链路

```text
用户输入产品目标
        ↓
ChatGPT 读取项目上下文
        ↓
生成当前阶段 Goal
        ↓
生成执行 Task
        ↓
选择执行模式
        ├─ Codex Exec
        └─ Codex TUI
        ↓
创建或绑定独立 Worktree
        ↓
Codex 修改代码并运行验证
        ↓
输出 Result + Evidence
        ↓
ChatGPT 严格验收
        ↓
        ├─ Pass
        │    ↓
        │  判断产品是否完成
        │    ├─ 是 → Goal 完成
        │    └─ 否 → 创建下一 Goal
        │
        ├─ Partial
        │    ↓
        │  创建收敛 Goal
        │
        ├─ Reject
        │    ↓
        │  创建修复 Goal
        │
        └─ Unknown
             ↓
           人工验收
```

---

## Goal 驱动

GPTWork 不直接把用户的整段需求交给执行器。

它先把产品目标转化为可推进、可验证、可结束的 Goal。

```text
Product Goal
    ↓
Goal 01：建立基础能力
    ↓
Goal 02：补齐核心流程
    ↓
Goal 03：完成自动验收
    ↓
Goal 04：完成异常恢复
    ↓
Goal 05：完成产品化收敛
    ↓
Product Done
```

每个 Goal 独立拥有：

- 原始用户目标
- 当前阶段目标
- Task 上下文
- 验收标准
- 执行记录
- 变更文件
- 测试结果
- Git 证据
- 审查结论
- 下一步决策

---

## Task 不是 Goal

```text
Goal
  ↓
描述“这一阶段必须达成什么”

Task
  ↓
描述“Codex 这一次具体做什么”
```

一个 Goal 可以包含多个 Task。

```text
Goal：完成登录系统
  ├─ Task 01：实现认证接口
  ├─ Task 02：实现登录页面
  ├─ Task 03：补齐集成测试
  └─ Task 04：修复验收缺陷
```

Task 完成不代表 Goal 完成。

Goal 完成也不一定代表整个产品完成。

---

## 自动验收闭环

GPTWork 的核心不是自动执行，而是自动验收。

```text
Codex 完成任务
      ↓
读取结构化结果
      ↓
核对变更文件
      ↓
核对测试结果
      ↓
核对命令输出
      ↓
核对 Git 状态
      ↓
核对验收合同
      ↓
生成验收结论
```

验收结论只有以下几类：

```text
Passed
  → 当前目标已满足

Partial
  → 已完成部分目标，需要继续收敛

Failed
  → 存在明确缺陷，需要修复

Blocked
  → 被外部条件阻塞

Unknown
  → 现有证据无法证明完成，进入人工验收
```

系统不会因为 Codex 输出“完成”就自动结束。

---

## 证据优先

GPTWork 不依赖执行器的自然语言自述判断结果。

```text
可信度从低到高：

执行器声称完成
      ↓
存在文件修改
      ↓
测试通过
      ↓
验收合同通过
      ↓
Git 集成完成
      ↓
产品目标被证明满足
```

常见证据包括：

- changed files
- commands
- tests
- verification report
- commit hash
- remote head
- integration result
- acceptance result
- reviewer decision

没有证据，不自动宣告完成。

---

## 失败恢复

GPTWork 区分三种失败：

```text
实现失败
  → 代码或逻辑不符合要求
  → 创建修复 Goal

执行失败
  → 命令、环境、依赖或进程失败
  → 根据证据恢复

证据缺失
  → 无法证明执行是否完成
  → 重建结果或进入人工验收
```

禁止逻辑：

```text
result.json 缺失
   ≠ 自动重跑原任务
   ≠ 自动创建 repair task
   ≠ 自动反复执行
```

正确逻辑：

```text
result.json 缺失
   ↓
从 Session、Git、Worktree、命令记录和 result.md 重建结果
   ↓
能证明的字段写入
不能证明的字段保持 null / unknown
   ↓
证据不足则进入人工验收
```

---

## 上下文管理

GPTWork 不把整段历史对话无差别塞给 Codex。

上下文按照来源和优先级组织：

```text
产品目标
   ↓
当前 Goal
   ↓
当前 Task
   ↓
验收合同
   ↓
项目约束
   ↓
相关文件
   ↓
历史决策
   ↓
执行证据
```

Codex 正常执行时读取的是有界上下文包，而不是无限增长的聊天记录。

```text
原始上下文
   ↓
筛选
   ↓
去重
   ↓
压缩
   ↓
来源标记
   ↓
Task Context Packet
```

这样可以降低：

- 上下文污染
- 无关信息干扰
- Token 浪费
- 历史错误持续传播
- 大型项目分析速度下降

---

## Codex Exec 与 Codex TUI

GPTWork 支持两种执行方式。

### Codex Exec

```text
Task
  ↓
结构化 Prompt
  ↓
Codex CLI 非交互执行
  ↓
结构化结果
  ↓
自动验收
```

适合：

- 显式指定的非交互执行流程
- 可预测任务
- 批量执行
- 并行任务
- CI 风格运行

### Codex TUI

```text
Goal
  ↓
启动原生 Codex TUI Session
  ↓
持续执行
  ↓
ChatGPT 中途检查
  ↓
普通纠偏或继续执行
  ↓
收集持久化证据
  ↓
最终验收
```

适合：

- 长时间复杂任务
- 需要连续交互的实现
- 需要观察执行过程
- 原生 Codex Session 管理

GPTWork 当前默认执行模式是 **Codex TUI**。只有任务或调用方明确选择 `codex_exec` 时，才切换到 Codex Exec。

两种模式都必须进入同一套验收闭环。

---

## TUI 中的纠偏原则

```text
Goal 01 执行中
      ↓
ChatGPT 检查
      ↓
发现轻微偏离
      ↓
直接发送普通纠偏指令
      ↓
继续当前 Goal
```

只有当前 Goal 已完成并验收后，才创建下一 Goal。

```text
不要：
发现小问题 → 立刻创建新 Goal

应该：
发现小问题 → 当前 Session 内纠偏
Goal 完成 → 严格验收
仍有缺口 → 创建下一 Goal
```

---

## 多任务并行

GPTWork 支持多个独立工作流并行推进。

```text
Product Goal
   ├─ Workstream A：后端
   │    ├─ Task A1
   │    └─ Task A2
   │
   ├─ Workstream B：前端
   │    ├─ Task B1
   │    └─ Task B2
   │
   └─ Workstream C：测试
        ├─ Task C1
        └─ Task C2
```

并行任务通过以下机制隔离：

- 独立 Goal
- 独立 Task Context
- 独立 Git Worktree
- Repo Lock
- Workstream DAG
- Join 节点
- 独立验收结果

---

## 多 Agent 协作

复杂任务可以经过多个角色协同处理。

```text
Context Curator
      ↓
Planner
      ↓
Builder
      ↓
Verifier
      ↓
Reviewer
      ↓
Finalizer
      ↓
Integrator
```

角色职责：

| 角色 | 职责 |
|---|---|
| Context Curator | 整理当前任务所需上下文 |
| Planner | 制定执行计划 |
| Builder | 修改代码并完成实现 |
| Verifier | 运行测试与验证 |
| Reviewer | 独立审查结果 |
| Repairer | 修复明确缺陷 |
| Finalizer | 汇总结果并决定是否可关闭 |
| Integrator | 合并、提交与集成 |

这些角色不是为了制造流程，而是为了分离执行与判断。

---

## Git Worktree 隔离

每个需要修改代码的任务都可以在独立 Worktree 中执行。

```text
主仓库
  ├─ Worktree A → Task A
  ├─ Worktree B → Task B
  └─ Worktree C → Task C
```

作用：

- 避免多任务互相覆盖
- 避免污染主工作区
- 支持并行执行
- 保留失败现场
- 便于独立验收
- 便于明确集成边界

---

## 状态流转

```text
created
   ↓
assigned
   ↓
running
   ↓
verifying
   ↓
reviewing
   ↓
   ├─ completed
   ├─ waiting_for_repair
   ├─ waiting_for_review
   ├─ blocked
   ├─ failed
   └─ cancelled
```

状态必须由证据驱动，而不是由一次自然语言回复驱动。

---

## 产品完成条件

```text
所有 Task 完成
      ≠ 产品完成

所有 Goal 完成
      ≠ 一定产品完成

产品目标被验收证明满足
      = 产品完成
```

最终关闭前至少需要确认：

- 核心需求已实现
- 阻断问题为零
- 必要测试通过
- 关键证据完整
- 集成状态明确
- 没有未处理的产品级缺口

---

## 快速开始

```bash
cd backend
npm install
npm link

gptwork init
gptwork start
```

本地检查：

```bash
gptwork doctor --local
gptwork status --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

生产初始化：

```bash
gptwork init --production
```

---

## 默认执行策略

默认运行配置位于：

```text
.gptwork/runtime.env
```

推荐默认配置：

```dotenv
GPTWORK_TOOL_MODE=full
GPTWORK_DELAYED_TOOL_DISCOVERY=true

GPTWORK_CODEX_HOME_MODE=user
GPTWORK_CODEX_TUI_ENABLED=true
GPTWORK_EXECUTE_PROVIDER=codex_tui_goal

GPTWORK_RECOVERY_PLANE_ENABLED=true
GPTWORK_CODEX_WORKER=true

GPTWORK_WORKSPACE_ROOT=/home/a9017/mcp/workspace
GPTWORK_STATE_PATH=/home/a9017/mcp/workspace/gpt-codex-workspace/.gptwork/state.json

GPTWORK_DEFAULT_REPO=9018/gpt-codex-workspace
GPTWORK_DEFAULT_REPO_PATH=/home/a9017/mcp/workspace/gpt-codex-workspace
GPTWORK_DEFAULT_BRANCH=main

GPTWORK_RECOVERY_ALLOWED_ROOTS=/home/a9017/mcp/workspace/gpt-codex-workspace
```

关键语义：

- `GPTWORK_DELAYED_TOOL_DISCOVERY=true`：启动时只暴露引导工具，其他工具按需发现，减少工具清单开销。
- `GPTWORK_CODEX_TUI_ENABLED=true`：启用 Codex TUI 执行能力。
- `GPTWORK_EXECUTE_PROVIDER=codex_tui_goal`：把 Codex TUI 设为默认执行 Provider。
- `GPTWORK_DEFAULT_REPO_PATH`：必须指向真实主仓库，不能省略中间的 `workspace` 目录。
- 配置优先级为 `process.env > .gptwork/runtime.env > 代码默认值`。

```text
默认自动执行
   ↓
Codex TUI

明确要求非交互执行
   ↓
Codex Exec

多个独立任务
   ↓
Workstream + Worktree 并行

执行完成
   ↓
统一进入 Evidence + Acceptance
```

---

## 发布检查

快速检查：

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

完整发布检查：

```bash
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

---

## 项目结构

```text
gpt-codex-workspace/
├─ backend/        → MCP 服务、Worker、执行与验收核心
├─ bin/            → 项目级命令入口
├─ plugins/        → 插件能力
├─ scripts/        → 初始化、检查和运维脚本
├─ data/           → 运行数据
├─ .gptwork/       → Goal、Task、Context、Evidence 与状态
└─ README.md       → 产品说明
```

---

## 设计原则

```text
Goal 优先于 Prompt
证据优先于声明
验收优先于结束
纠偏优先于重开
重建优先于重跑
隔离优先于共享
产品完成优先于任务完成
```

---

## 最终目标

GPTWork 希望把软件开发从：

```text
人不断提醒 AI 下一步做什么
```

变成：

```text
人提供产品目标
      ↓
ChatGPT 持续负责规划与验收
      ↓
Codex 持续负责实现与验证
      ↓
系统自动修正并继续推进
      ↓
产品完成
```
