[English](README.md) | 中文说明

# GPT-Codex Workspace 中文文档

GPTWork 是一个后端 MCP 服务，用来协调 ChatGPT、Codex 和本地/远端代码工作空间。ChatGPT 负责理解用户请求、创建目标和查看结果；Codex 在隔离的 worktree 中执行修改、验证、提交并写回结构化结果；GPTWork 负责目标、任务、上下文、队列、证据、review 和安全边界。

本文是当前中文主文档。英文 [README.md](README.md) 只保留简洁入口，细节以本文和 `docs/` 为准。

## 移动端纯文本渲染（默认）

GPTWork 默认使用原生文本返回工具结果，不再为每次工具调用创建 Apps SDK HTML 卡片。这样可以显著减少长会话在手机上的滚动卡顿、内存占用和发热。

```bash
GPTWORK_RENDER_MODE=text
```

可选值：

- `text`：纯文本和受限结构化数据，不加载卡片资源；默认且推荐。
- `selective`：仅代码变更、审核和交接等低频结果使用卡片。
- `card`：恢复完整 v5 卡片，适合桌面展示和兼容测试。

修改后需要重启 GPTWork，并在 ChatGPT 中刷新或重新连接应用，使缓存的工具描述符失效。旧消息中的历史卡片不会被追溯替换。

## 这是什么

GPTWork 解决的是“ChatGPT 发起，Codex 执行，结果可验收”的协作问题：

- ChatGPT 通过 MCP 工具创建 `goal`，把用户意图、上下文摘要和执行约束写入 `.gptwork/goals/<goal_id>/`。
- GPTWork 后端保存 goal/task 状态，构建小包化上下文，管理队列、repo 锁、worktree、验收契约和运行诊断。
- Codex 从有界入口 `codex.entry.md` 开始读取，优先使用 `context.bundle.md`，在指定 worktree 内修改代码并写回 `result.json` / `result.md`。
- 自动验收逻辑用命令证据、结果证据、状态断言和收口决策判断任务能否关闭。

GPTWork 不是部署平台，也不是 secrets 管理系统。它只协调执行和证据流；真实密钥必须放在运行环境或本地忽略文件中，不能写入文档、提交或 goal payload。

## 当前能力

当前 main 已落地的核心能力包括：

- MCP 工具模式：`minimal`、`standard`、`operator`、`codex`、`full`，用于控制 ChatGPT/Codex/运维侧能看到的工具面。
- 目标与任务：`create_encoded_goal`、`create_goal`、`create_task`、`assign_task_to_codex`、队列工具和兼容入口仍可用。
- 有界上下文：新 goal 会写 `codex.entry.md`，存在检索结果时写 `context.bundle.md`、`context.retrieval.json` 和 `context.manifest.json`。
- 小包化 review/context：`get_task_acceptance_bundle` 和 `get_task_review_packet` 返回最小证据包，不返回完整 transcript、memory、大段 diff 或完整 context bundle。
- 自动验收模型：acceptance contract、operation-specific evidence、contract-aware verifier、state assertions、deterministic closure 已拆成独立模块。
- Zvec context-index：可选使用 `@zvec/zvec` 做可重建上下文索引；不可用时可回退本地 JSON store。
- GitHub Issues fallback：没有可被 ChatGPT 访问的 HTTPS MCP 入口时，可用 GitHub Issues 作为任务下发和结果同步通道。
- 运维诊断：`open_project_context`、`project_context_status` / `context_status`、`runtime_status`、`worker_status`、`gptwork_doctor`、safe restart、retention/recovery 工具。
- **Agent 执行后端**：所有 pipeline 角色默认 `codex_exec`（自动 Codex 执行）。可通过 `GPTWORK_AGENT_ROLE_BACKENDS` 为特定角色配置 `local_command` 或 `null` 后端。
- **Worker runtime gate**：生产环境必须启用 worker（`GPTWORK_CODEX_WORKER=true`），否则任务无法自动推进。
- **自我修复与交付恢复**：超时、脏 worktree、changed_files 误判等场景有专用自我修复路径和交付恢复机制。
- **Pipeline gate 硬性门禁**：新 builder/deploy/admin 任务在关闭前必须通过 pipeline gate 检查（verification、reviewer_decision、integration 等 artifact 必须存在）。
- **产品状态仪表盘**：`product_status` 单命令显示 running commit、worker health、queue 进度、当前 blocker、review 分类和推荐下一步操作。
- 集成收口：支持按任务 worktree 执行，成功后通过 ff-only 路径进入 canonical main；push branch 或 open PR 不等于 merged。

## 快速开始

要求：Node.js 22+ 和 npm。

```bash
cd backend
npm install
npm link
gptwork init
gptwork start
```

### 生产初始化

对于生产部署，使用 `--production` 标志启用生产 profile 检查：

```bash
cd backend
npm install && npm link
gptwork init --production   # 一键初始化+生产 profile 验证
```

生产 profile 检查包括：
- **production\_worker**（阻塞级）：Worker 必须启用（`GPTWORK_CODEX_WORKER=true`）
- **role\_commands**（阻塞级）：当 verifier/reviewer 使用 `local_command` 后端时必须配置对应命令
- **release\_gate\_commands**（推荐）：配置交付验证命令
- **codex\_exec\_settings**（推荐）：超时>=3600s，并发数>=1
- **current\_head**：对比当前 HEAD 与文档 baseline
- **workspace\_settings**：检查 workspace root、state path、default repo 设置
- **context\_vector\_store**：检查向量存储配置
- **integration\_mode**：检查集成模式

阻塞级检查未通过时会中断初始化并给出修复建议。

### Agent 执行后端

生产默认执行后端是 `codex_exec`（自动 Codex 执行路径），适用于所有 pipeline 角色。verifier、reviewer、integrator、finalizer 等角色默认也使用 `codex_exec`，但可通过 `GPTWORK_AGENT_ROLE_BACKENDS` 显式切换为 `local_command` 或 `null` 后端。

`codex_tui_goal` 是 **显式 Operator fallback**——仅操作员手动选择，不会自动降级到 TUI。Operator 需要在终端会话中交互式工作，并写入 durable evidence（result.json，建议同时包含 commit、tests、result.md）；result.json 被收集后会规范化为标准 taskResult，继续进入与 `codex_exec` 相同的 verifier、acceptance、integration、finalizer 和 queue auto-start 闭环。

### 本地检查

另开终端做本地检查：

```bash
cd backend
gptwork init        # 一键初始化+诊断
gptwork doctor --local  # 详细诊断（含 env 校验）
gptwork doctor --production  # 生产 profile 诊断
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

如有缺失项，自动修复：

```bash
gptwork fix         # 自动创建缺失文件和依赖
```

常用发布前检查：

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

发布候选版本需要在 clean worktree 上运行三组产品门禁：

```bash
cd backend
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
```

`release:delivery-check` 覆盖交付系统和兼容面，`release:tui-first-loop-gate` 覆盖 TUI-first loop smoke path，`release:check` 是 baseline package 发布门禁。完整门禁覆盖两种交付模式：无 GitHub 的本地 goal/task/worktree 执行，以及可选 GitHub Issues adapter 的导入/幂等/跳过原因链路；同时覆盖旧任务兼容层，保证历史 task 记录无需直接改写也能被验收、review 和队列状态展示消费。

`health` 返回 200 只表示服务进程响应了请求，不表示当前运行的是期望 commit。确认部署是否生效时还要看 `runtime_status.running_commit`、重启 marker、进程启动时间和预期 commit。

## ChatGPT / Codex 连接

### ChatGPT

ChatGPT 侧优先使用标准 MCP 工具面。新会话建议先调用：

```text
open_project_context
```

它返回当前 repo、worker、queue、脚本、近期任务/目标、有界文件树和推荐下一步工具。需要执行代码修改、部署或多步骤维护时，再创建 encoded goal：

```text
create_encoded_goal(preview_text, payload_base64, assign_to_codex=true, wait_ms=180000)
```

连接 URL 通常形如：

```text
https://<public-host>/mcp/<token>
```

路径后缀会被后端当作 bearer token。文档中只使用占位符，不记录真实 token。

### Codex

Codex 通过插件或本地 MCP 连接后端。Codex 任务提示会要求先读：

```text
.gptwork/goals/<goal_id>/codex.entry.md
```

默认上下文读取顺序是：

1. `codex.entry.md`：本次任务的有界执行入口，必须先读。
2. `context.bundle.md`：存在时优先作为支持上下文。
3. `context.manifest.json`：Context Curator 诊断和 artifact 映射；不是默认任务上下文。
4. `context.json`：只做元数据查找，不鼓励全文读取。
5. `goal.md` / `transcript.md`：只有入口和 bundle 不足时才深读。
6. payload 文件：仅在调试编码或字段缺失时读取。

## 典型工作流

```text
用户提出需求
  -> ChatGPT 调用 open_project_context
  -> ChatGPT 创建 create_encoded_goal
  -> GPTWork 写入 goal 文件、验收契约和上下文 bundle
  -> 任务入队或分配给 Codex
  -> Codex 在独立 worktree 内执行修改、测试、提交
  -> Codex 写 result.json / result.md 和 legacy stdout report
  -> GPTWork 归一化 verification/evidence/integration
  -> contract verifier 与 closure decider 判断是否可关闭
  -> 需要人工判断时进入 review，而不是直接视为失败
```

对大任务应拆分成小 goal。review 和上下文读取也应优先使用小包化接口，避免读取完整 goal context、完整 transcript 或大段 diff。

## 自动验收模型

GPTWork 把几个容易混淆的概念分开处理：

| 概念 | 含义 |
|---|---|
| verification | 命令或检查是否通过，例如 syntax/import/test/release check。 |
| acceptance | 用户目标是否满足，由验收契约、结果证据、状态断言和阻塞项共同判断。 |
| integration | 修改是否进入 canonical main 或被明确标记为不需要集成。 |
| deployment | 运行环境是否已经使用目标 commit 或目标配置。 |
| closure | 当前任务是否可以关闭。 |
| review | 需要人工判断或补充证据，不等于失败。 |

重要边界：

- `branch_pushed` 不等于 `merged`。
- `pr_opened` 不等于 `merged`。
- `merged` 不等于 `deployed`。
- `health 200` 不等于正在运行 expected commit。
- `quality_notes` 和 `non_blocking_followups` 不阻塞当前任务关闭。
- 缺少 `result.json`、verification 或必要 integration evidence 时会形成 `missing_evidence`。

核心模块：

- `backend/src/acceptance/`：契约生成、契约 schema、语义检查、contract-aware verifier。
- `backend/src/acceptance-gate-engine.mjs`：独立验收闸门，统一调用 verifier、contract verifier 和 closure decider，并写出 `verification.json` / `acceptance.json`。
- `backend/src/evidence/`：不同操作类型的证据归一化和 profile。
- `backend/src/assertions/`：状态断言运行器。
- `backend/src/closure/`：确定性收口决策和 follow-up 规划。
- `backend/src/review/`：acceptance bundle 与 review packet。
- `backend/src/integration-queue.mjs`、`backend/src/auto-integration-completion.mjs`：集成状态和 ff-only 自动完成。
- `backend/src/agent-execution-backends.mjs`：G3 Agent 执行后端抽象，支持 `codex_exec`/`local_command`/`null` 及按角色路由。
- `backend/src/pipeline-orchestration.mjs`：多 Agent pipeline gate 编排和强制执行。
- `backend/src/self-healing-policy.mjs`：自我修复策略（超时、脏 worktree、changed_files 不匹配）。

### 独立 Verifier 与 Acceptance Gate

任务进入完成态前必须先经过独立 verifier。verifier 负责运行命令检查、复用有效 verification report、验证 result evidence 和 acceptance contract，并把结果写入 goal 目录下的 `verification.json`。Acceptance Gate Engine 读取 verifier 输出、验收契约、integration/deployment evidence 和 closure policy，写入同目录的 `acceptance.json`，并只返回三类结果：

| Gate status | 含义 | 后续状态 |
|---|---|---|
| `passed` | verification 通过，阻塞验收项满足，可自动关闭。 | `completed` |
| `failed` | 任务自身报告失败或不可恢复失败。 | `failed` |
| `needs_action` | verification、contract、integration 或语义判断仍缺证据/需修复。 | `waiting_for_repair` 或 `waiting_for_review` |

旧任务流程仍兼容：finalizer 继续接受既有 `verifyTaskCompletionFn` 注入和 legacy `result.json` 字段；新增 gate 只补充 `acceptance_gate` / `acceptance_result_path` 证据，并复用现有 repair、review、follow-up 和 closure 决策。

## 小包化 review/context

人工 review 或 ChatGPT 复核任务时，优先调用：

```text
get_task_review_packet(task_id)
get_task_acceptance_bundle(task_id)
```

这些接口返回 contract 摘要、result summary、verification、contract_verification、closure_decision、changed_files、blockers/followups、missing_evidence 和 recommended_next_action。它们不会返回完整 transcript、durable memories、完整 context bundle 或大段 diff。

`open_project_context` 用于会话开场的项目快照。`project_context_status` / `context_status` 用于上下文健康诊断。只有在这些小包信息不足以判断时，才读取更大的 goal 文件。

## Zvec context-index

Zvec 是可重建的上下文索引，不是事实源。事实源仍是 goal/task/result/conversation 状态文件、Git 提交和运行时诊断。

配置入口：

```bash
GPTWORK_CONTEXT_VECTOR_STORE=auto
GPTWORK_CONTEXT_VECTOR_STORE=zvec
GPTWORK_CONTEXT_VECTOR_STORE=local
```

`auto` 会在 `@zvec/zvec` 可用时使用 Zvec collection store，否则回退本地 JSON store。`zvec` 会强制使用 Zvec，不可用时报告明确失败。`context.retrieval.json` 记录检索模式、store 能力、embedding provider、top-K、预算和入选 chunk 原因。

## GitHub Issues fallback

当 ChatGPT 无法访问公网 HTTPS MCP 入口时，可使用 GitHub Issues 作为 fallback：

1. ChatGPT 或用户创建带约定标签的 Issue。
2. GPTWork 使用 `sync_from_github` 导入任务。
3. Codex 执行任务并写回结果。
4. GPTWork 用 `sync_to_github` 和 `sync_github_comments` 同步状态、结果和评论。

GitHub token 只应通过运行环境或 workflow secret 注入。文档、Issue 正文和 goal payload 不应包含真实 token。

### 双模式发布判据

| 模式 | 入口 | 必须验证 |
|---|---|---|
| 无 GitHub | `create_goal` / `create_encoded_goal` / queue | goal 创建、Codex 执行、自动验收、repair/review、integration、队列推进。 |
| 有 GitHub | `gptwork-task` / `gptwork-question` + intake marker / inbox handoff | dry-run 无副作用、apply 创建 task、重复导入幂等、question 无 intake 被跳过、skip reason 可见。 |
| 旧任务兼容 | 历史 task/result 字段 | `goalId`、`done` / `open` / `in_progress` 等旧状态，以及 result 内的 tests/verification/reviewer_decision 可归一化为当前 delivery contract。 |

完整发布门禁会运行 `G10 no-GitHub delivery E2E`、`G10 GitHub adapter delivery E2E` 和 `G10 legacy compatibility tests` 三组检查；任一失败都不应发布。

## 运维诊断
- 产品级状态面板：`product_status`，一行命令给出 running commit、worker health、queue progress、current blockers、review 分类、retention pressure、TUI provider 状态和 prioritized next actions。

常用路径：

- 项目开场：`open_project_context`。
- 上下文诊断：`project_context_status` 或 `context_status`。
- 服务诊断：`runtime_status`、`worker_status`、`gptwork_doctor`、`gptwork_self_test`。
- recovery plane：`recovery_stale_queue_unblock`、repo lock 工具、retention 工具和 tmp/goal cleanup 工具。
- 安全重启：任务内不要直接杀进程或 inline restart；先写结果和 commit，再调用 `schedule_service_restart(task_id, expected_commit, expected_remote_head?)`。
- 发布检查：`node scripts/release-delivery-check.mjs --fast`。
- repo clean：提交后用 `git status --short` 确认可交付 worktree 干净。

## 安全边界

- 默认 ChatGPT 使用 `standard`，不暴露 `shell_exec`。
- `full` 仅用于操作员调试或紧急处理。
- 路径 token、API token、GitHub token、Bark key 等 secrets 不能写入 README、docs、goal payload、result 或 Issue。
- `.gptwork/runtime.env` 是服务级配置；`.gptwork/project.env` 是项目上下文配置。两者都不应提交真实 secret。
- 文件工具必须限制在选定 workspace root 内。
- 任务执行只在指定 execution repo/worktree 内改文件；canonical repo 集成由 ff-only 或明确集成流程完成。

## 常用命令

```bash
cd backend
npm install
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
npm run release:delivery-check
npm run release:tui-first-loop-gate
npm run release:check
node bin/gptwork.mjs init        # 一键初始化+诊断
node bin/gptwork.mjs doctor --local  # 详细诊断
node bin/gptwork.mjs status --local
node bin/gptwork.mjs connect --local
node bin/gptwork.mjs self-test --local
node bin/gptwork.mjs fix         # 自动修复缺失项
```

队列相关：

```bash
cd backend
node bin/gptwork.mjs queue list
node bin/gptwork.mjs queue start-next --dry-run
```

## 目录结构

```text
backend/
  bin/gptwork.mjs                 CLI 入口
  scripts/                        语法、导入和交付检查脚本
  src/acceptance/                 验收契约、语义和 verifier
  src/assertions/                 状态断言
  src/closure/                    收口决策与 follow-up 规划
  src/context-index/              context bundle、retrieval、Zvec/local store
  src/evidence/                   操作证据归一化
  src/review/                     acceptance bundle、review packet
  src/tool-groups/                MCP 工具分组（runtime-status、codex-tui、recovery、self-test 等）
  src/agent-execution-backends.mjs 多 Agent 执行后端抽象
  src/task-*.mjs                  任务生命周期、执行、结果写回
  src/codex-*.mjs                 Codex prompt、worker、run metadata、finalizer helpers
docs/
  architecture.md                 架构和模块边界
  current-status.md               当前已落地能力
  operations.md                   运维 runbook
  delivery/                       交付、上下文、worktree 和验收契约文档
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 英文简洁入口。 |
| [docs/current-status.md](docs/current-status.md) | 当前 main 已落地能力和术语边界。 |
| [docs/architecture.md](docs/architecture.md) | 模块职责和数据流。 |
| [docs/operations.md](docs/operations.md) | 诊断、recovery、安全重启和交付检查。 |
| [docs/delivery/context-and-worktree-contract.md](docs/delivery/context-and-worktree-contract.md) | `codex.entry`、`context.bundle`、review packet、worktree 和 ff-only integration 语义。 |
| [docs/delivery/acceptance-and-repair-contract.md](docs/delivery/acceptance-and-repair-contract.md) | 验收与修复契约。 |
| [docs/delivery/release-gate.md](docs/delivery/release-gate.md) | 发布门禁和 TUI/release checklist。 |
| [docs/setup-connect.md](docs/setup-connect.md) | 安装与连接指南。 |
| [docs/goal-queue.md](docs/goal-queue.md) | goal queue 语义。 |
| [docs/github-fallback.md](docs/github-fallback.md) | GitHub Issues fallback。 |
| [docs/chatgpt-prompting-guide.md](docs/chatgpt-prompting-guide.md) | ChatGPT 侧使用建议。 |

## License

MIT

## 当前产品化状态（P0/P1 Series）

当前 main 已经合入以下产品化能力：

| Goal | 状态 | 能力 |
|---|---|---|
| P0-01 Release Gate Hardening | ✅ **已处理（CI Workflow）** | 通过 CI workflow 和 release-gate.md 文档落地，含全量 syntax/import/test/e2e 发布门禁 |
| P0-02 Retention Cleanup Productization | ✅ **已完成** | git_branches/git_worktrees 保留族、storage_pressure、分支修剪 |
| P0-03 Review State Auto-Resolution | ✅ **已完成** | 6 种规范 review 分类（evidence_missing/policy_uncertain/...） |
| P0-04 Pipeline Gate Hardening | ✅ **已完成** | 新 builder/deploy/admin 任务强 gate 检查，旧任务兼容 |
| P0-05 Real Agent Backends | ✅ **已合并** | 所有 pipeline 角色默认统一为 codex_exec；local_command/null 仅作为显式覆盖 |
| P0-06 Init Onboarding Productization | ✅ **已合并** | `gptwork init/doctor/fix` 产品化开机流程 |
| P0-07 Codex Exec Production Hardening | ✅ **已完成** | timeout/无输出/脏 worktree/changed_files 误判自愈 |
| P1-08 Codex TUI Operator Fallback | ✅ 完成 | codex_exec 默认生产，codex_tui 显式 fallback |
| P1-09 Operator Dashboard Status | ✅ 完成 | `product_status` 一站式仪表盘 |
| **P1-10 最终收敛（本任务）** | ✅ **已完成** | 全局文档/验收/门禁检查 — 文档状态已统一 |

### 产品边界明确划分

- **codex_exec**: 默认生产执行模式，适用于所有 pipeline 角色。
- **codex_tui**: 显式 Operator fallback，仅操作员手动选择，不自动降级。
- **多 Agent 角色**: context_curator → planner → builder → verifier → reviewer → integrator → finalizer + repairer（recovery 分支）。
- **Review 自动归宿**: 6 种规范分类，blocker-policy 和 review packet 内置。
- **Acceptance gate**: 独立验收闸门，合并 verification → contract verification → closure decision，自动关闭通过的任务。
- **Init/Onboarding**: `gptwork init / doctor --local / fix` 产品化流程。
- **Retention**: `retentionCleanup` 支持 git 分支修剪、worktree 诊断、storage_pressure 门禁。
- **Status Dashboard**: `product_status` 单命令面板。

## Workstream 产品化

GPTWork 提供了完整的 Workstream 产品化契约（G1–G7）：

- **Workstream 身份与 CRUD**：访问控制、执行/验收策略
- **上下文链接**：ChatGPT 会话、Codex 线程、GitHub Issue 关联
- **DAG 编排**：fan-out/join、容量限制、拓扑排序
- **漂移/停滞检测**：阶段/范围错误、进度停滞、TUI 死亡、锁过期
- **验收控制器**：判定（通过/失败/部分/阻塞）、修复预算（最多 2 次）、ChatGPT 升级
- **Tick 控制器**：每周期最多 5 次状态转换
- **小时巡检契约**：漂移纠正、停滞恢复、直接编辑优先、幂等性
- **Apps SDK 卡片**：Workstream 健康运营仪表盘

验证命令：

```bash
# E2E 产品化 + 小时巡检测试（25 项测试）
node --test backend/test/e2e-workstream-productization.test.mjs backend/test/workstream-hourly-supervisor.test.mjs

# 所有 Workstream 测试
node --test backend/test/workstream-*.test.mjs

# 完整测试套件
npm --prefix backend test
```

完整文档：[docs/workstreams/tui-productization/README.md](docs/workstreams/tui-productization/README.md)。
