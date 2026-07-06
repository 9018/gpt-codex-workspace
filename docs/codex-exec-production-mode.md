# codex_exec 生产执行模式

## 概述

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
- 不可修复 → `waiting_for_review` 并附带精确的 `review_reason`
- delivery recovery → 自动提交 dirty worktree 并 merge


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
- `dirty_worktree`: worktree 有未提交变更
- `commit_missing`: 存在 dirty work 但没有 commit 证据

## Pipeline 角色与执行后端

默认 pipeline 中各角色的执行后端：

| 角色 | 默认后端 | 执行语义 | 说明 |
|------|---------|---------|------|
| context_curator | null/auto_artifact | 自动 | 从任务元数据准备 context bundle |
| planner | null/auto_artifact | 自动 | 从 context/prompt 文件确定计划 |
| builder | codex_exec | 真实执行 | Codex CLI 自动执行代码变更 |
| verifier | local_command | 确定执行 | 本地 shell 命令确定性验证 |
| reviewer | local_command | 确定执行 | 本地 shell 命令确定性审查 |
| integrator | null/auto_artifact | 自动 | 从集成结果证据自动完成 |
| finalizer | null/auto_artifact | 自动 | 从任务结果证据自动完成 |
| repairer | codex_exec | 真实执行 | Codex CLI 自动修复尝试 |

**关键语义**：只有 builder 和 repairer 使用真实的 Codex LLM agent 执行。verifier 和 reviewer 使用本地 shell 命令（确定性、非 LLM）。context_curator、planner、integrator、finalizer 使用 null/auto_artifact 后端（从已有证据自动完成，不执行外部命令）。

## 运行时诊断

`collectCodexTuiRuntimeDiagnostics()` 返回完整的 TUI 运行时状态，包括：
- session 数量、活跃/运行计数
- completion 状态（no_result、result_missing 等）
- findings 包含精确的诊断信息
- 每个 session 的 evidence 状态（result_md、worktree_clean、commit 等）

在 doctor/release report 中，TUI 模式始终被标记为 `optional` 和 `explicit_only`，默认 provider 永远是 `codex_exec`。
