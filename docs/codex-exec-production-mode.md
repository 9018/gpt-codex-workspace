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

