# Codex Execution Mode and Multi-Agent Pipeline Documentation

## codex_exec 生产执行模式 (正式默认路径)

`codex_exec` 是 GPTWork 的默认生产执行模式。所有任务默认使用 `codex exec` CLI 执行。

## 异常路径分类与处理

### 1. `no_first_output_timeout`
- **failure_class**: `no_first_output_timeout`
- **severity**: `recoverable`
- **healing_action**: `compact_and_retry`
- **review_reason**: `null`（不需要 review，自动重试）
- **can_auto_retry**: `true`
- **Next action**: 压缩 context bundle 后自动重试。这是基础设施/资源问题，不需要代码修复。

### 2. `codex_timeout`
- **failure_class**: `codex_timeout`
- **severity**: `failed`（无部分证据）/ `recoverable`（有部分证据）
- **healing_action**: `compact_and_retry`
- **creates_delivery_recovery**: `true`（有部分证据时）
- **review_reason**: `codex_timeout_with_partial_evidence`（有部分证据时）
- **Next action**: 从 worktree 恢复部分工作并重试。

### 3. `result_missing`
- **failure_class**: `result_missing`
- **healing_action**: `fallback_parse_and_retry`
- **Review**: `result_missing_no_evidence`
- **Next action**: 回退到 stdout/last-message 解析器。

### 4. `dirty_worktree_after_codex`
- **category**: `DIRTY_WORKTREE_AFTER_CODEX`
- **healing_action**: `recover_delivery_result`
- **Next action**: delivery_result_recovery 将提交更改并 ff-only merge 到 canonical repo。

### 5. `changed_files_mismatch`
- **category**: `CHANGED_FILES_MISMATCH`
- **healing_action**: `reconcile_changed_files_from_git`
- **Next action**: 从 `git diff --name-only` 重新获取 changed_files。

### 6. `no_first_output_timeout` vs `timeout`
- `no_first_output_timeout`: codex CLI 启动后从未产生任何输出
- `timeout` (codex_timeout): codex CLI 启动并产生输出但超时

### 7. 生产模式核心逻辑

```
codex exec → 结果解析 → 接受度检查 → delivery recovery → finalizaton
```

所有非正常路径的自动归宿：
- 可修复 → 创建 repair task 或自动重试
- 不可修复 → `waiting_for_review` 并附带精确的 `review_reason` / `blocking_findings`
- delivery recovery → 自动提交 dirty worktree 并 merge

### 8. 生产模式探测：Model / Provider / 推理效率

`executeCodexTaskRun()` 在 codex CLI 横幅输出中提取：
```
model: gpt-5-codex
api provider: openai
reasoning effort: high
```

这些提取结果写入 `parsedResult.model`、`parsedResult.provider`、`parsedResult.reasoning_effort`，
以及 `codexMeta` 诊断元数据。详见 `extractHeaderMetadata()` 在 `task-codex-execution.mjs`。

### 9. 执行参数重解析

`resolveCodexExecArgs()` 在每次执行时重新解析 codex exec CLI 参数，而不是使用启动时的快照配置。
优先级：`task.metadata.codex_exec_args` > `process.env.GPTWORK_CODEX_EXEC_ARGS` > `config.codexExecArgs` > 默认 `--yolo --skip-git-repo-check`。

---

# Agent 执行后端语义 (Execution Backend Semantics)

AGENT_BACKEND_SEMANTIC 将每个角色的后端执行分为四种层级（`agent-execution-backends.mjs`）：

| 语义 | 后端 | 含义 | 行为 |
|------|------|------|------|
| `real` | `codex_exec` 或 `local_command` | 真实执行 | 实际环境执行命令或 agent，产生 side effect |
| `auto_artifact` | `null` | 自动证据衍生 | 从任务结果证据中自动完成，不执行外部命令 |
| `test_noop` | `null` | 测试桩 | 测试中的空操作，明确标记 test_only |
| `configured` | `null` | 显式 operator 选择 | operator 明确指定该角色使用 null 后端 |

**关键区分**：`real` 包含两类执行——
- `codex_exec`：通过 Codex CLI 运行 LLM agent（builder/repairer）
- `local_command`：通过本地 shell 命令确定性执行（verifier/reviewer）

两者都是有 side effect 的"真实执行"，只是执行手段不同。`null` 后端不从外部环境产生新证据，仅从已有任务结果证据自动完成。

---

# codex_tui_goal: 人工 operator fallback 模式

## 概述

`codex_tui_goal` 是 **人工 operator fallback** 模式，不是全自动执行替代品。与 `codex_exec` 不同，TUI 模式启动一个交互式终端会话，由人工 operator 在终端中逐步工作。

## 模式语义对比

| 特性 | codex_exec (默认生产路径) | codex_tui_goal (人工 fallback) |
|------|--------------------------|-------------------------------|
| 自动化程度 | 全自动，无需人工干预 | 人工驱动，operator 在终端中操作 |
| 启动方式 | `codex exec` CLI 自动执行 | 交互式 PTY 会话 |
| 证据收集 | 自动产生结构化 result.json/result.md | 需要 operator 主动写入 result.md |
| 验收闭环 | 自动进入 closure/acceptance 流程 | 需要先收集 durable evidence |
| 适用场景 | 标准编码/验证任务 | 复杂调试、人工审查、实验性操作 |

## 从 TUI evidence 回到验收闭环的路径

TUI 模式完成工作需要以下 durable evidence 才能进入验收闭环：

1. **result.md**: 必须存在于 `.gptwork/goals/{goal_id}/result.md`，包含任务摘要
2. **commit**: 可通过 result.md 的 `Commit:` 字段或 session 元数据提供
3. **Tests**: 可通过 result.md 的 `Tests:` 或 `Verification:` 字段提供
4. **Clean worktree**: 所有变更应已提交，worktree 无未跟踪更改

当 `collectCodexTuiCompletion()` 返回 `ready_for_review=true` 时，表示 evidence 链完整，可以进入验收流程。

### Evidence 链检查点

```
TUI 会话完成 → collectCodexTuiCompletion()
  ├─ result.md 存在？→ 继续
  ├─ worktree clean？→ 继续
  ├─ commit 证据存在？→ 继续
  └─ ready_for_review=true → 进入验收闭环
```

如果 evidence 不完整（例如缺少 commit 或 dirty worktree），`findings` 会包含精确的 blocking reason：
- `result_md_missing`: result.md 不存在
- `dirty_worktree`: TUI worktree 有未提交变更
- `commit_missing`: 存在 dirty work 但没有 commit 证据

## TUI 启用条件

`codex_tui_goal` 启用需要同时满足：
1. **运行时配置启用**：`config.codexTuiEnabled = true` 或 `env.GPTWORK_CODEX_TUI_ENABLED = true`
2. **任务元数据选择**：`task.metadata.codex_execution_provider = "codex_tui_goal"`

两个条件缺一不可。如果任务选择 TUI 但运行时未启用，
`collectCodexTuiRuntimeDiagnostics()` 会报告 `codex_tui_goal_disabled` finding。

## TUI Superpowers 插件预检

当 `GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=true` 或 `config.requireSuperpowersPluginForTuiFallback=true` 时，
TUI 回退需要 Superpowers 插件可用（`checkSuperpowersPluginForTuiFallback()` in `codex-execution-provider.mjs`）。

如果插件缺失，返回：
```json
{
  "available": false,
  "diagnostic": {
    "code": "superpowers_plugin_missing",
    "message": "TUI fallback requires the Superpowers plugin but it is not installed.",
    "remediation": "Install the Superpowers plugin via: codex --install-plugin superpowers, or disable the check with GPTWORK_REQUIRE_SUPERPOWERS_FOR_TUI=false."
  }
}
```

TUI 会话不能启动，`codex_exec` 保持为回退 provider。

## Codex 执行 Provider 描述

`describeCodexExecutionProvider()`（`codex-execution-provider.mjs`）为诊断和文档提供明确的 provider 区分：

| Provider | 标签 | 默认 | 人工回退 | 描述 |
|----------|------|------|---------|------|
| `codex_exec` | `codex_exec (default automatic production path)` | 是 | 否 | 默认生产执行路径。通过 CLI 自动运行，产生结构化结果合同、验证证据和提交。除非明确配置为 codex_tui_goal，所有任务默认此 provider。 |
| `codex_tui_goal` | `codex_tui_goal (manual operator fallback)` | 否 | 是 | **人工 operator 回退模式**。operator 在交互式终端会话中工作，必须收集持久证据（commit、tests、result.md）才能进入验收/验证闭环。 |

`getTaskExecutionProviderMode(task)` 返回任务级别的 provider 解析结果，包括 `explicit`、`is_default`、`is_manual_fallback` 和完整描述。

## Pipeline 角色与执行后端

默认 pipeline 中各角色的后端、语义与执行来源：

| 角色 | 默认后端 | 执行语义 | 证据来源 | 说明 |
|------|---------|---------|---------|------|
| context_curator | `null` | `auto_artifact` | `null (auto_artifact — no external commands)` | 从任务元数据自动准备 context bundle |
| planner | `null` | `auto_artifact` | `null (auto_artifact — no external commands)` | 从 context/prompt 文件自动确定计划 |
| builder | `codex_exec` | `real` | `codex_exec (real agent execution)` | Codex CLI 自动执行代码变更 |
| verifier | `local_command` | `real` | `local_command (deterministic shell command)` | 本地 shell 命令确定性验证 |
| reviewer | `local_command` | `real` | `local_command (deterministic shell command)` | 本地 shell 命令确定性审查 |
| integrator | `null` | `auto_artifact` | `null (auto_artifact — no external commands)` | 从集成结果证据自动完成 |
| finalizer | `null` | `auto_artifact` | `null (auto_artifact — no external commands)` | 从任务结果证据自动完成 |
| repairer | `codex_exec` | `real` | `codex_exec (real agent execution)` | Codex CLI 自动修复尝试 |

`repairer` 是恢复分支（recovery branch），不属于主线默认 pipeline（`DEFAULT_AGENT_PIPELINE`）。
主线 pipeline 执行顺序：`context_curator → planner → builder → verifier → reviewer → integrator → finalizer`。

**关键语义总结**：
- 只有 builder 和 repairer 使用真实的 Codex LLM agent 执行（`codex_exec` / `real`）
- verifier 和 reviewer 使用本地 shell 命令确定性执行（`local_command` / `real` — 注意这也属于 `real` 语义）
- context_curator、planner、integrator、finalizer 使用 `null` 后端（`auto_artifact` — 从已有证据自动完成，不执行外部命令）

### 后端覆盖顺序

`resolveAgentBackendId()` 的优先级（`agent-execution-backends.mjs`）：
1. **任务级**：`task.agent_backend` / `task.metadata.agent_backend`
2. **角色级配置**：`config.agentRoleBackends` / `config.agentBackendByRole`
3. **全局配置**：`config.agentBackend` / `config.agentBackendDefault`
4. **角色默认值**：`ROLE_BACKEND_DEFAULTS`（上表所列）

## Product Status Dashboard 中的 Provider 信息

`product_status` dashboard 包含 TUI Provider 部分，数据来自 `collectCodexTuiRuntimeDiagnostics()`。
在 dashboard 中：
- TUI 模式标记为 `optional` 和 `explicit_only`
- 默认 provider 永远是 `codex_exec`
- 显示 session 数量、active/running 计数
- 报告 findings 最高 severity

## 运行时诊断：TUI 完整诊断结构

`collectCodexTuiRuntimeDiagnostics()`（`codex-tui-runtime-diagnostics.mjs`）返回的完整顶层字段：

```json
{
  "provider": "codex_tui_goal",
  "provider_label": "codex_tui_goal (optional, explicit provider)",
  "optional": true,
  "activation": "explicit_only",
  "default_provider": "codex_exec",
  "enabled": "是否启用",
  "config_source": "config | process.env | default",
  "explicit_task_count": "选择 codex_tui_goal 的任务数",
  "session_store": {
    "present": "session 目录是否存在",
    "readable": "是否可读",
    "session_count": "总 session 数",
    "active_count": "活跃 session 数",
    "running_count": "运行中 session 数",
    "invalid_record_count": "损坏的记录数",
    "retained_reference_count": "引用有效资源的记录数",
    "stale_reference_count": "引用已删除 worktree 路径的记录数"
  },
  "completion": {
    "ready_for_review_count": "可进入验收闭环的 session 数",
    "no_result_count": "没有 result.md 也没有 result.json",
    "result_missing_count": "没有 result.md",
    "result_json_missing_count": "有 result.md 但没有 result.json",
    "commit_missing_count": "有 dirty worktree 但没有 commit",
    "dirty_worktree_count": "worktree 有未提交变更",
    "tests_missing_count": "没有 tests 证据"
  },
  "findings": "详细发现列表（code, severity, category, session_id, task_id, message）",
  "sessions": "每个 session 的详细摘要"
}
```

### TUI Completion Collector 完整字段

`collectCodexTuiCompletion()`（`codex-tui-completion-collector.mjs`）返回的 evidence snapshot：

```json
{
  "kind": "codex_tui_completion_snapshot",
  "session_id": "session ID",
  "goal_id": "goal ID 或 null",
  "task_id": "task ID 或 null",
  "changed_files": "从 git status --short + git diff --name-only 合并去重，过滤 .gptwork/ 内部路径",
  "tests": "从 session.metadata.tests 或 result.md 的 Tests:/Verification: 字段提取",
  "commit": "从 session.commit 或 result.md 的 Commit: 字段提取",
  "result_md_present": "result.md 文件是否存在",
  "worktree_clean": "changed_files 长度是否为 0",
  "ready_for_review": "所有条件满足时可以进入验收闭环",
  "findings": "精确的 blocking findings（result_md_missing, dirty_worktree, commit_missing）"
}
```

## 生产执行故障分类与运行时指标

`executeCodexTaskRun()` 和 `task-codex-execution.mjs` 中的执行流记录以下运行时指标：

| 指标 | 来源 | 说明 |
|------|------|------|
| `stdout_bytes` / `stderr_bytes` | 流输出 | 输出大小 |
| `first_stdout_at` / `first_stderr_at` | 首次输出时间戳 | 首次输出时机 |
| `first_output_delay_ms` | 首次输出延迟 | 从启动到首次输出的毫秒延迟 |
| `content_first_output_at` / `content_first_output_delay_ms` | 内容首次输出 | 模型首次返回有意义的非 banner 内容的时间 |
| `last_content_progress_at` | 最后内容进度 | 最后有意义的模型输出时间 |
| `no_content_first_output_timeout` | 内容超时 | 模型在规定时间内未返回任何有意义输出 |
| `no_content_progress_timeout` | 进度超时 | 模型有首次输出但在规定时间内未继续 |
| `no_first_output_timeout` | 首次输出超时 | codex CLI 启动后从未产生任何输出 |

当无法提取结构化摘要时，`parsedResult._no_structured_summary` 和
`parsedResult._fallback_diagnostic` 为 review packet 提供精确的诊断信息和修复建议。

## 修复 Agent 运行结果规范化

`normalizeBackendResult()`（`agent-execution-backends.mjs`）将所有后端执行结果规范化为统一结构：

| 字段 | 说明 |
|------|------|
| `execution_semantic` | `real` / `auto_artifact` / `test_noop` / `configured` |
| `evidence_source` | `codex_exec (real agent execution)` / `local_command (deterministic shell command)` / `null (auto_artifact — no external commands executed)` |
| `null_reason` | `auto_artifact` / `test_only` / `configured_null` |
| `command` | cmd、cwd、exit_code、timed_out |
| 继承字段 | 从 `parsed` 传递的结构化字段 |

`buildPipelineRoleBackendChain()` 生成可读的 pipeline 角色-后端链：
```
builder → codex_exec (real agent execution)
verifier → local_command (deterministic shell command)
reviewer → local_command (deterministic shell command)
context_curator → null/auto_artifact (auto-completed from evidence, no external commands)
planner → null/auto_artifact
integrator → null/auto_artifact
finalizer → null/auto_artifact
repairer → codex_exec (real agent execution)
```

## Retention 压力诊断

`product_status` dashboard 包含 retention 健康检查，由 `retentionPressure()`（`product-status-view.mjs`）
根据任务/目标数量相对于 `GPTWORK_RETENTION_LIMIT`（默认 50）评估：

| 压力级别 | 条件 |
|----------|------|
| `none` | task ≤ limit 且 goal ≤ limit |
| `medium` | task > limit 或 goal > limit（但不超过 2x limit） |
| `high` | task > 2*limit 或 goal > 2*limit |

`node scripts/release-storage-pressure.mjs` 可作为 CI/CD pre-release gate 使用，
报告任务/目标计数 vs 配置限制的存储压力。

## Worktree 清理与 Retention 工具

| 工具 | 功能 |
|------|------|
| `retention_status` / `retention_cleanup` | 检查并清理过期的目标、任务、git branches 和 worktree |
| `tmp_status` / `cleanup_tmp` | 扫描并清理临时文件 |
| `goal_storage_status` / `cleanup_goals` | 扫描并清理持久化目标目录 |

上述工具支持 `dry_run=true` 模式，保留已有证据。清理策略包括：
- `always_remove`：任务完成后立即移除 worktree
- `remove_on_success_retain_on_failure`：成功时移除，失败/review 时保留
- `always_retain`：从不自动移除 worktree

详见 `docs/delivery/context-and-worktree-contract.md`。

---

*本文档同步自 codebase 当前实现。如有不一致，以 `backend/src/` 中各模块为准。*
