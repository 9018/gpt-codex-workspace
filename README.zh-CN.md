[English](README.md) | 中文说明

# GPT-Codex Workspace

## 新功能：目标队列执行

参见 `docs/goal-queue.md` 了解真实的目标执行队列能力。

Open Goal 不会被自动执行。只有放入执行队列（Queue）的 Goal 才会被顺序处理。
依赖管理、仓库并发锁和工作目录检查确保安全执行。



**GPTWork** —— ChatGPT 与 Codex 双向协作的后端 MCP 服务。

通过这套系统，你可以用自然语言在 ChatGPT 中描述需求，由 Codex 在工作空间中执行代码修改、运行测试、提交结果，整个过程通过 MCP（Model Context Protocol）衔接。

---

## 项目简介

GPTWork 是一个轻量级后端 MCP 服务，充当 **ChatGPT** 与 **Codex** 之间的协调层。三者协作关系如下：

- **ChatGPT** 接收用户自然语言请求，通过 `create_encoded_goal` 创建编码目标，写入可读的 goal 文件，再通过 MCP 协议传递给后端。
- **GPTWork 后端**（MCP Server）存储目标、任务、对话记录，管理工作空间与工具注册表，并控制工具的暴露范围（tool mode）。
- **Codex** 发现已分配的目标，读取 goal 文件上下文，在工作空间中执行代码修改、测试、验证，最终写回结果。

此外，**GitHub Issues** 可作为备选通信通道——当 ChatGPT 无法直连 MCP 端点时（比如没有公网 HTTPS），可以通过 GitHub Issue 进行任务下发与结果同步。

---

## 当前状态

- P0 / P1 / P2 全部完成。
- E2E 产品验收 **PASS**（38 项自动化测试全部通过）。
- 详情见 [docs/e2e-acceptance.md](docs/e2e-acceptance.md)。
- 默认 Codex 执行超时时间：**3600 秒**（可通过 `GPTWORK_CODEX_EXEC_TIMEOUT` 调整）。

---

## 快速开始

### 环境要求

- Node.js >= 22
- npm

### 安装与启动

```bash
cd backend
npm install
npm link
gptwork setup
gptwork settings set GPTWORK_TOOL_MODE standard
gptwork start
```

在另一个终端验证：

```bash
gptwork doctor --local
gptwork status --local
curl http://127.0.0.1:8787/health
gptwork connect --local
gptwork self-test --local
详细的安装与连接指南请参考 [docs/setup-connect.md](docs/setup-connect.md)。

```

### ChatGPT MCP 接入

ChatGPT 端添加 MCP 连接，填入示例地址（不要使用真实 token）：

```
Connector URL: https://mcp.example.com/mcp/your-dev-token
Auth: none
```

路径中的后缀会被后端提取为鉴权 token。具体连接地址以实际部署为准。

也可以在无公网 HTTPS 的情况下使用 **GitHub Issues** 模式进行协调（见下方说明）。

### 配置文件

环境变量通过 `.gptwork/runtime.env` 配置，该文件已被 `.gitignore` 排除，不会提交到仓库。

```bash
# 示例（不要写入真实 secret）
GPTWORK_HOST=0.0.0.0
GPTWORK_PORT=8787
GPTWORK_TOOL_MODE=standard
```

---

## CLI 命令

所有命令在 `backend/` 目录下通过 `gptwork` 执行：

| 命令 | 说明 |
|------|------|
| `gptwork setup` | 初始化工作空间与状态文件 |
| `gptwork start` | 启动 MCP 服务 |
| `gptwork status --local` | 查看服务状态与队列信息 |
| `gptwork doctor --local` | 运行诊断，检查环境配置 |
| `gptwork connect --local` | 查看本地 MCP URL 与连接选项 |
| `gptwork self-test --local` | 运行系统自检 (PASS/WARN/FAIL) |
| `gptwork settings show` | 查看当前配置 |
| `gptwork logs` | 查看服务日志 |
| `gptwork watch-handoff --dry-run` | 模拟监听 handoff 目录 |
| `gptwork watch-handoff --once` | 单次监听 handoff 目录后退出 |

---

## MCP 工具能力概览

GPTWork 提供以下类别的 MCP 工具：

| 类别 | 包含工具 |
|------|----------|
| **Goal / Task** | `create_encoded_goal`、`create_goal`、`list_goals`、`get_goal_context`、`append_goal_message`、`create_task`、`list_tasks`、`get_task`、`assign_task_to_codex`、`complete_task` |
| **Agent / Pipeline / Handoff** | `run_agent_pipeline`、`handoff_to_agent`、`read_handoff` |
| **事件日志 / 最近活动** | `read_events` |
| **工作空间文件读写** | `list_dir`、`read_text_file`、`write_text_file`、`search_files`、上传下载等 |
| **Git 远程检查** | `git_remote_status`、`git_remote_diff`、`show_changes` |
| **GitHub / Bark 同步与通知** | `sync_to_github`、`sync_from_github`、`sync_github_comments`、`github_status`、`notification_status` |
| **Widget 卡片** | 通过 MCP `resources/list` 和 `resources/read` 提供 GPTWork Compact Card（HTML 格式） |

具体可见英文 README 中的完整工具列表。

---

## Tool Mode 说明

GPTWork 通过 `GPTWORK_TOOL_MODE` 控制工具暴露范围，共 5 种模式：

| 模式 | 说明 |
|------|------|
| **minimal** | 最小安全集合：仅暴露健康检查、状态查询、基本信息读取。适合只读场景。 |
| **standard** | 默认模式：暴露 goal/task/agent/handoff 工具，适合日常 ChatGPT 使用。不含 `shell_exec`。 |
| **operator** | 诊断模式：暴露所有诊断工具，不含 agent/handoff。适合运维排查。 |
| **codex** | 执行模式：包含 `shell_exec`、`write_text_file`、事件读取、handoff 等执行工具。Codex 自身使用。 |
| **full** | 完全模式：全部工具开放，包括 `schedule_service_restart`。仅用于调试或紧急操作。 |

**安全边界**：ChatGPT 前端使用 `minimal` 或 `standard`，不会暴露 `shell_exec` 等高风险工具。即使用户通过 ChatGPT 直接调用受限工具，也会被工具注册表拒绝（返回 `-32601 Unknown tool`）。

---

## E2E 验收

完整的 E2E 验收报告见 [docs/e2e-acceptance.md](docs/e2e-acceptance.md)。

在本地运行验收测试：

```bash
cd backend
npm run test:e2e-acceptance
```

---

## 常用验证命令

```bash
cd backend
npm run check:syntax       # 语法检查
npm run check:imports      # 模块导入检查
npm test                   # 运行所有单元测试
node bin/gptwork.mjs doctor --local   # 运行环境诊断
```

---

## GitHub / Bark 配置说明

### GitHub Issues 同步

通过环境变量启用，用于无公网 HTTPS 时的任务协调：

```bash
# .gptwork/runtime.env
GPTWORK_GITHUB_ENABLED=true
GPTWORK_GITHUB_REPO=your-org/your-repo
# GPTWORK_GITHUB_TOKEN=ghp_xxx   请替换为真实 token
```

未配置时，GitHub 相关工具会返回 graceful 的禁用状态，不会报错。

### Bark 通知

Bark 是 iOS 推送通知工具，可选配置：

```bash
GPTWORK_BARK_ENABLED=true
GPTWORK_BARK_KEY=your-bark-key
GPTWORK_BARK_URL=https://api.example.com/push
```

不配置 Bark 时，通知工具会清晰提示状态已禁用，不会报错中断。

**注意**：所有 token、key 均通过环境变量配置，`.gptwork/runtime.env` 已在 `.gitignore` 中。任何情况下都不要将 secret 提交到 Git 仓库。

---

## 故障排查

### MCP 不显示工具
- 检查服务是否启动：`curl http://127.0.0.1:8787/health`
- 检查 ChatGPT 连接地址是否正确，`/mcp/<token>` 路径中的 token 是否与服务端配置匹配

### Tool mode 下工具缺失
- 运行 `gptwork doctor --local` 查看当前 `tool mode`
- 如需更全的工具，设置为 `gptwork settings set GPTWORK_TOOL_MODE full`
- 但请注意 `full` 模式会暴露 `shell_exec`，仅限调试使用

### Codex 任务超时
- 默认超时 3600 秒。可在 `runtime.env` 中增加：
  ```bash
  GPTWORK_CODEX_EXEC_TIMEOUT=7200
  ```
- 大任务可考虑拆分为多个 goal，减少单次执行时间

### GitHub sync 未启用
- 运行 `gptwork doctor --local` 查看 `github:` 状态
- 确认 `GPTWORK_GITHUB_ENABLED=true` 和 `GPTWORK_GITHUB_REPO`、`GPTWORK_GITHUB_TOKEN` 已正确配置
- 未配置时工具返回 graceful 禁用状态，不影响核心功能

### Bark 未通知
- 运行 `notification_status` 工具查看 Bark 配置和连接状态
- 检查 `GPTWORK_BARK_ENABLED`、`GPTWORK_BARK_KEY`、`GPTWORK_BARK_URL`
- 可通过 `gptwork doctor --local` 查看诊断信息

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [docs/current-status.md](docs/current-status.md) | 当前运行状态与环境信息 |
| [docs/e2e-acceptance.md](docs/e2e-acceptance.md) | E2E 产品验收报告 |
| [docs/refactor/gptwork-server-map.md](docs/refactor/gptwork-server-map.md) | 服务模块职责映射 |
| [docs/architecture.md](docs/architecture.md) | 系统架构设计 |
| [docs/chatgpt-prompting-guide.md](docs/chatgpt-prompting-guide.md) | ChatGPT 编码目标使用指南 |

---

## License

MIT
