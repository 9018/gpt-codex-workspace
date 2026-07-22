# GPTWork

> 文档基准：2026-07-22，按当前源码整理，不以历史文档为准。
>
> ChatGPT 负责规划与验收，Codex 负责执行与取证，GPTWork 后端负责状态、调度与收口。

GPTWork 是一个面向复杂软件项目的 AI 执行编排系统。

它不是“让模型改完代码就结束”的工具，而是一套围绕 **Goal / Task / Evidence / Acceptance / Repair / Integration** 的闭环运行时：

```text
产品目标
  -> ChatGPT 规划 Goal
  -> 后端创建/关联 Task
  -> Codex Worker 调度执行
  -> 收集 result + git + 测试证据
  -> Acceptance / Finalizer 判定
  -> 修复、集成、人工审核或继续下一 Goal
```

---

## 源码入口

```text
bin/gptwork.mjs
  -> backend/bin/gptwork.mjs          # CLI：setup/init/start/status/doctor/queue...
  -> backend/src/cli.mjs              # 服务启动

backend/src/gptwork-server.mjs        # MCP server 组合根
backend/src/codex-worker-loop.mjs     # 周期 worker
backend/src/task-processing/
  task-execution-runner.mjs           # 单任务主执行链
plugins/gpt-codex-workspace/mcp/server.mjs
                                      # stdio 代理，转发到远程/本地 MCP
```

默认监听：

```text
http://127.0.0.1:8787/mcp
GET  /health
POST /mcp   # JSON-RPC over SSE
```

状态真相源：

```text
${GPTWORK_WORKSPACE_ROOT}/.gptwork/state.json
${GPTWORK_WORKSPACE_ROOT}/.gptwork/goals/<goal_id>/
```

---

## 系统角色

```text
用户
  - 给产品目标，处理必须人工的决策

ChatGPT / MCP 客户端
  - 创建 Goal/Task
  - 管理上下文
  - 审阅 review packet
  - 提交 supervisor decision

GPTWork Backend
  - MCP tools / 状态机 / 队列 / lock / worktree
  - worker 调度
  - acceptance / repair / integration / finalizer
  - supervisor review 控制面

Codex
  - 读 goal 上下文
  - 改代码、跑命令、写 result
  - 通过 codex_tui_goal 或 codex_exec 返回证据
```

原则：

```text
ChatGPT 决策
Codex 执行
证据证明
后端收口
```

---

## 真实执行链路

源码中的主路径是：

```text
create_encoded_goal / create_goal / create_task
  -> ensureTaskGoal + 写 .gptwork/goals/<id>/*
  -> task.assignee=codex, status=queued|assigned, mode=full
  -> codex-worker-loop tick
  -> runAssignedCodexTasks
  -> processGeneralTask
  -> runTaskExecution
       1. ensure goal / pipeline agent_runs
       2. resolve repo plan
       3. materialize worktree 或 canonical 执行
       4. acquire repo lock
       5. prepare prompt / run files
       6. dispatch provider (codex_tui 优先, codex_exec 回退)
       7. 收集 result/evidence
       8. acceptance agent + convergence
       9. repair 或 integration
      10. pipeline gate
      11. final writeback
```

说明：

- worker 只执行 `mode === "full"` 的任务；创建时会把普通 builder 语义 normalize 成 `full`。
- `task-processing-pipeline.mjs` 仍是薄包装；真正逻辑在 `task-execution-runner.mjs`。
- provider 层有新旧两套痕迹；默认仍走旧 dispatcher，`useExecutionRun` 不是默认路径。

---

## Goal 与 Task

### Goal

描述“这一阶段要达成什么”，并拥有可读工作区：

```text
.gptwork/goals/<goal_id>/
  goal.md
  context.json
  transcript.md
  codex.entry.md
  result.md / result.json
  acceptance.contract.json
  ...
```

### Task

描述“worker 这一次具体执行什么”，并挂在 state store 的状态机上。

常见关系：

```text
Goal
  └─ Task(s)
       ├─ 主实现 task
       ├─ repair task
       └─ integration / follow-up
```

Goal 完成不等于产品完成；Task 完成也不等于 Goal 完成。

---

## 执行 Provider

源码默认自治 provider 是 **`codex_tui_goal`**。

| Provider | 含义 | 何时使用 |
|---|---|---|
| `codex_tui_goal` / `codex_tui` | 原生 Codex TUI session + 证据收集 | 默认；auto 选择时优先 |
| `codex_exec` | `codex exec` 非交互执行 | 显式指定，或 TUI 不可用时的 availability fallback |

相关代码：

- `backend/src/codex-execution-provider.mjs`
- `backend/src/execution/provider-selection-policy.mjs`
- `backend/src/task-processing/task-provider-dispatcher.mjs`

TUI 路径要求：

- `GPTWORK_CODEX_TUI_ENABLED` 默认 true
- 需要 `node-pty` 或系统 `script(1)`
- 证据不足时进入人工审核，不会盲目重跑或乱建 repair

注意：`GPTWORK_EXECUTE_PROVIDER` 的代码默认值当前是 `claude_tui_goal`，它属于更上层 stage/loop 配置；**Codex task 执行默认仍是 `codex_tui_goal`**。部署时建议显式写清楚：

```dotenv
GPTWORK_EXECUTE_PROVIDER=codex_tui_goal
GPTWORK_ACCEPT_PROVIDER=codex_tui_goal
GPTWORK_CODEX_TUI_ENABLED=true
```

---

## 验收与收口

执行结束后不会因为模型说“完成”而关闭任务。后端会综合：

- `result.json` / `result.md`
- changed files / commit / tests
- acceptance findings
- integration 结果
- pipeline agent_runs 门禁
- finalizer 决策

`task-finalizer.mjs` 的核心结论包括：

- `completed`
- `waiting_for_repair`
- `waiting_for_integration`
- `waiting_for_review`
- `failed` / `timed_out` / `blocked`

证据缺失时的正确行为：

```text
result 不足
  -> 从 session / git / worktree / result.md 尽量重建
  -> 不能证明的字段保持 unknown
  -> 进入 waiting_for_review
  != 自动重跑原任务
  != 自动无限 repair
```

---

## 任务状态机

完整状态定义在 `backend/src/task-status-taxonomy.mjs`。简化视图：

```text
queued / assigned
  -> running / starting / collecting / accepting
  -> repairing / integrating
  -> waiting_for_lock
  -> waiting_for_repair
  -> waiting_for_integration
  -> waiting_for_review / waiting_for_supervisor / typed review states
  -> completed | failed | timed_out | blocked | cancelled
```

typed review 例子：

- `waiting_for_evidence_missing`
- `waiting_for_policy_uncertain`
- `waiting_for_integration_uncertain`
- `waiting_for_repair_budget_exhausted`
- `waiting_for_provider_unavailable`
- `waiting_for_human_required`

状态必须由证据和策略驱动，不由一句自然语言“完成了”驱动。

---

## 隔离与并行

普通代码任务默认：

```text
execution_mode=worktree
enableTaskWorktrees=true
```

效果：

- 独立 git worktree / branch
- repo lock 保护 canonical 路径
- 多 task 可并行推进
- 失败现场可保留用于验收和修复

deploy / admin / 显式 canonical 任务会走主仓路径，而不是 worktree。

更高层还有：

- Goal Queue：依赖、ready/running、完成后 auto-start
- Workstream：跨 task 工作流与 join
- Supervisor Review：有界人工/上层纠偏控制面

---

## 多角色 Pipeline

新任务通常会初始化 agent_runs 管道：

```text
context_curator
  -> planner
  -> builder
  -> verifier
  -> reviewer
  -> finalizer
  -> integrator
```

`pipeline-orchestration.mjs` 会在收口前检查关键 gate。legacy task 可 bypass，但会打标记。

---

## 快速开始

```bash
cd backend
npm install
npm link   # 可选，便于全局调用 gptwork

gptwork init
gptwork start
```

本地诊断：

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

启用 worker：

```bash
# runtime.env 或环境变量
GPTWORK_CODEX_WORKER=true
```

`cli.mjs` 只有在 `config.codexWorker === true` 时才会启动 Codex worker。

---

## 默认配置

配置优先级：

```text
process.env > .gptwork/runtime.env > 代码默认值
```

常见默认值（见 `backend/src/runtime-config.mjs`）：

| Key | 代码默认 | 说明 |
|---|---|---|
| `GPTWORK_HOST` | `127.0.0.1` | 监听地址 |
| `GPTWORK_PORT` | `8787` | 监听端口 |
| `GPTWORK_TOOL_MODE` | `standard` | MCP 工具暴露模式 |
| `GPTWORK_DELAYED_TOOL_DISCOVERY` | `false` | 延迟工具发现 |
| `GPTWORK_CODEX_WORKER` | `false` | 是否启动周期 worker |
| `GPTWORK_CODEX_TUI_ENABLED` | `true` | TUI provider 开关 |
| `GPTWORK_ENABLE_TASK_WORKTREES` | `true` | 默认 worktree 隔离 |
| `GPTWORK_SUPERVISOR_WORKER_ENABLED` | `true` | supervisor review worker |

推荐本地/生产明确写出：

```dotenv
GPTWORK_HOST=127.0.0.1
GPTWORK_PORT=8787
GPTWORK_TOOL_MODE=full
GPTWORK_DELAYED_TOOL_DISCOVERY=true
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_TUI_ENABLED=true
GPTWORK_EXECUTE_PROVIDER=codex_tui_goal
GPTWORK_ACCEPT_PROVIDER=codex_tui_goal

GPTWORK_WORKSPACE_ROOT=/absolute/path/to/workspace
GPTWORK_STATE_PATH=/absolute/path/to/workspace/.gptwork/state.json
GPTWORK_DEFAULT_REPO_PATH=/absolute/path/to/repo
GPTWORK_DEFAULT_BRANCH=main
```

---

## 发布检查

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

完整：

```bash
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

---

## 项目结构

```text
gpt-codex-workspace/
├─ bin/                         # 仓库级 CLI 入口
├─ backend/
│  ├─ bin/gptwork.mjs           # 完整 CLI
│  ├─ src/
│  │  ├─ cli.mjs                # 服务启动
│  │  ├─ gptwork-server.mjs     # MCP 组合根
│  │  ├─ state-store.mjs        # 状态存储
│  │  ├─ server-tools.mjs       # tool groups 装配
│  │  ├─ codex-worker-*.mjs     # worker 调度
│  │  ├─ task-processing/       # 任务执行主链
│  │  ├─ codex-tui/             # TUI session
│  │  ├─ execution*/            # 新 execution 抽象（迁移中）
│  │  ├─ acceptance*/           # 验收合同
│  │  ├─ supervisor-review/     # 上层审核控制面
│  │  ├─ workstream/            # 工作流
│  │  └─ tool-groups/           # MCP tools
│  ├─ test/                     # 大量回归测试
│  └─ scripts/                  # release / e2e / gate
├─ plugins/gpt-codex-workspace/ # MCP 代理与 skill
├─ data/workspaces/default/     # 默认 runtime workspace
├─ docs/                        # 架构/运维/交付文档
└─ README.md
```

---

## 设计原则

```text
Goal 优先于 Prompt
证据优先于声明
验收优先于结束
纠偏优先于盲目重开
重建证据优先于盲目重跑
隔离优先于共享工作区
产品完成优先于任务完成
```

---

## 进一步阅读

- [Architecture](docs/architecture.md)
- [Closed-Loop Automation](docs/closed-loop-automation.md)
- [Closure and Acceptance](docs/closure-acceptance.md)
- [Setup and Connect](docs/setup-connect.md)
- [Operations](docs/operations.md)
- [Release Gate](docs/delivery/release-gate.md)
- [Backend README](backend/README.md)
