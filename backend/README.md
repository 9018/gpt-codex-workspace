# GPTWork Backend

按当前源码整理（2026-07-22）。本目录包含 MCP 后端、CLI、Codex worker、验收/修复/集成闭环、release gate 与测试。

## 启动

```bash
npm install
npm link   # 可选
gptwork init
gptwork start
```

`gptwork start` 最终进入 `backend/src/cli.mjs`：

1. 解析 `runtime.env` / 环境变量
2. `createGptWorkServer()`
3. 监听 `GPTWORK_HOST:GPTWORK_PORT`（默认 `127.0.0.1:8787`）
4. 启动 storage janitor
5. 仅当 `GPTWORK_CODEX_WORKER=true` 时启动 Codex worker

本地诊断：

```bash
gptwork doctor --local
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

生产初始化：

```bash
gptwork init --production
```

## 源码地图

| 路径 | 职责 |
|---|---|
| `src/cli.mjs` | 进程启动、端口锁、worker 开关 |
| `src/gptwork-server.mjs` | MCP server 组合根 |
| `src/http-handler.mjs` | `/health`、`/mcp` SSE/JSON-RPC |
| `src/state-store.mjs` | `state.json` 持久化与索引 |
| `src/server-tools.mjs` | 装配 tool groups |
| `src/codex-worker-loop.mjs` | 周期 tick / idle 退避 |
| `src/codex-worker-runner.mjs` | 候选任务选择与单任务调度 |
| `src/task-processing/task-execution-runner.mjs` | 单任务主执行链 |
| `src/task-finalizer.mjs` | 终态决策 |
| `src/pipeline-orchestration.mjs` | agent_runs 管道与 gate |
| `src/goal-queue.mjs` | Goal 队列与 auto-start |
| `src/codex-tui/` | TUI session 管理 |
| `src/execution/` / `src/executions/` | 新 execution 抽象（迁移中） |
| `src/supervisor-review/` | supervisor 审核控制面 |

## 产品默认

来自源码，不是旧文档：

- Codex task 默认自治 provider：`codex_tui_goal`
- `codex_exec` 是显式选择，或 TUI unavailable 时的 availability fallback
- worker 只处理 `mode === "full"`
- 普通代码任务默认 `execution_mode=worktree`
- 新非 legacy task 默认要求 pipeline gates
- TUI 证据不足时进入 human review，不自动无限 repair

相关实现：

- `src/codex-execution-provider.mjs`
- `src/execution/provider-selection-policy.mjs`
- `src/goal-task-task-factory.mjs`
- `src/task-processing/task-execution-runner.mjs`

## 配置

优先级：

```text
process.env > .gptwork/runtime.env > 代码默认值
```

关键默认值（`src/runtime-config.mjs`）：

```text
GPTWORK_HOST=127.0.0.1
GPTWORK_PORT=8787
GPTWORK_TOOL_MODE=standard
GPTWORK_DELAYED_TOOL_DISCOVERY=false
GPTWORK_CODEX_WORKER=false
GPTWORK_CODEX_TUI_ENABLED=true
GPTWORK_ENABLE_TASK_WORKTREES=true
GPTWORK_SUPERVISOR_WORKER_ENABLED=true
```

推荐显式配置：

```dotenv
GPTWORK_TOOL_MODE=full
GPTWORK_DELAYED_TOOL_DISCOVERY=true
GPTWORK_CODEX_WORKER=true
GPTWORK_CODEX_TUI_ENABLED=true
GPTWORK_EXECUTE_PROVIDER=codex_tui_goal
GPTWORK_ACCEPT_PROVIDER=codex_tui_goal
GPTWORK_CODEX_TUI_EVIDENCE_WAIT_MS=30000
GPTWORK_WORKSPACE_ROOT=/absolute/path/to/workspace
GPTWORK_STATE_PATH=/absolute/path/to/workspace/.gptwork/state.json
GPTWORK_DEFAULT_REPO_PATH=/absolute/path/to/repo
GPTWORK_DEFAULT_BRANCH=main
```

说明：

- `GPTWORK_EXECUTE_PROVIDER` 代码默认仍是 `claude_tui_goal`（上层 stage/loop 配置）。
- Codex task provider 选择与 `normalizeCodexExecutionProvider()` 默认到 `codex_tui_goal`。
- 部署时不要假设“没写配置就等于你想要的生产策略”。

## Tool Modes

`src/server-tools.mjs`：

- `minimal`
- `standard`（代码默认）
- `operator`
- `codex`
- `full`

delayed discovery 开启后，先暴露引导工具，其余通过 `tool_search` / `tool_describe` 发现。

## Worker 行为

`startCodexWorker()` 默认：

- interval: `GPTWORK_CODEX_WORKER_INTERVAL_MS=5000`
- concurrency: `GPTWORK_CODEX_WORKER_CONCURRENCY=4`
- idle 指数退避，上限 `GPTWORK_CODEX_WORKER_BACKOFF_MAX_MS`
- 启动时 reconcile stale tasks
- 周期 GitHub sync / maintenance / historical convergence

单 tick：

```text
runAssignedCodexTasks
  -> reconcile runtimes
  -> recover accepted/verified review tasks
  -> reconcile queue items
  -> drain progression commands
  -> 选 active codex candidates
  -> 空槽时 startQueuedGoals
  -> non_blocking 时后台 launch 单任务
```

## 测试与发布门

快速：

```bash
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

更完整：

```bash
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

常用脚本：

```bash
npm test
npm run test:e2e-acceptance
npm run release:state-boundary:gate
npm run release:autonomous-runtime
```

## 文档

- [Root README](../README.md)
- [Architecture](../docs/architecture.md)
- [Closed-Loop Automation](../docs/closed-loop-automation.md)
- [Closure and Acceptance](../docs/closure-acceptance.md)
- [Setup and Connect](../docs/setup-connect.md)
- [Operations](../docs/operations.md)
- [Release Gate](../docs/delivery/release-gate.md)
