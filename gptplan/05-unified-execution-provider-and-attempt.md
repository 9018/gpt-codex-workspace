# 05 exec/TUI 统一 ExecutionProvider 与 ExecutionAttempt 方案

## 目标

将 exec 和全自动 TUI 统一为同一运行协议，主任务链不再包含 provider 特殊分支。

## 主要文件

### 新增

- `backend/src/execution/execution-attempt-schema.mjs`
- `backend/src/execution/execution-attempt-store.mjs`
- `backend/src/execution/execution-provider-contract.mjs`
- `backend/src/execution/execution-provider-registry.mjs`
- `backend/src/execution/execution-orchestrator.mjs`
- `backend/src/execution/execution-checkpoint.mjs`
- `backend/src/execution/execution-evidence.mjs`
- `backend/src/execution/providers/codex-exec-provider.mjs`
- `backend/src/execution/providers/codex-tui-provider.mjs`
- `backend/src/execution/provider-selection-policy.mjs`
- `backend/src/execution/provider-failover-policy.mjs`

### 修改

- `backend/src/codex-execution-provider.mjs`
- `backend/src/task-codex-execution.mjs`
- `backend/src/codex-tui-session-manager.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/codex-worker-runner.mjs`
- `backend/src/task-final-writeback.mjs`

### 测试

- 新增 `backend/test/execution-provider-contract.test.mjs`
- 新增 `backend/test/execution-attempt-store.test.mjs`
- 新增 `backend/test/execution-provider-routing.test.mjs`
- 新增 `backend/test/execution-provider-failover.test.mjs`
- 新增 `backend/test/execution-attempt-recovery.test.mjs`

## Provider 接口

```js
export class ExecutionProvider {
  async start(attempt, context) {}
  async observe(handle, context) {}
  async send(handle, input, context) {}
  async interrupt(handle, context) {}
  async resume(attempt, checkpoint, context) {}
  async collect(handle, context) {}
  async dispose(handle, context) {}
}
```

TUI 的 `send` 由 autopilot 调用，不是人工调用。

## Attempt 模型

```js
{
  id,
  task_id,
  goal_id,
  provider,
  provider_revision,
  state,
  path_context,
  input_snapshot,
  checkpoint,
  provider_handle,
  evidence,
  failure,
  attempt_number,
  created_at,
  updated_at
}
```

## 实施任务

1. 建立 contract test，exec/TUI 都必须通过同一测试套件。
2. 把现有 `executeCodexTaskRun` 封装进 exec provider。
3. 把 TUI session manager + autopilot 封装进 TUI provider。
4. 主 orchestrator 只处理统一状态：
   `starting/running/evidence_ready/completed/failed/timed_out/provider_unavailable`。
5. provider selection 依据 task policy：
   - explicit tui → TUI。
   - explicit exec → exec。
   - auto → 根据任务类型、历史成功率和可用性选择。
6. failover 必须保持同一 task、同一 worktree、同一 input snapshot，创建新 attempt。
7. failover 生成 checkpoint：
   - repo HEAD。
   - dirty paths。
   - completed acceptance items。
   - last error。
   - native session ID。
8. exec → TUI 和 TUI → exec 都必须可自动发生，不依赖人工。
9. 一个 task 同时只能有一个 active attempt；使用 compare-and-swap claim。
10. provider evidence 全部转换成 `ExecutionEvidence`，后续验收不知道 provider 类型。
11. 删除 `task-general-processor` 中 exec/TUI 大型 if/else。
12. 所有 provider 失败都由统一 failure classifier 处理。

## 自动切换策略

示例：

```js
if (exec.noContentOutput && exec.retryCount >= 1) return "codex_tui";
if (exec.structuredResultFailures >= 2) return "codex_tui";
if (tui.ptyUnavailable) return "codex_exec";
if (tui.autopilotRepeatedPromptLoop) return "codex_exec";
```

切换后仍自动执行，不能等待人工。

## 验收命令

```bash
cd backend
node --test test/execution-provider-contract.test.mjs
node --test test/execution-attempt-store.test.mjs
node --test test/execution-provider-routing.test.mjs
node --test test/execution-provider-failover.test.mjs
node --test test/execution-attempt-recovery.test.mjs
node --test test/codex-tui-provider-routing.test.mjs
npm run check:syntax
npm run check:imports
```
