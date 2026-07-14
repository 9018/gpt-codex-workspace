# GPTWork Codex Exec / TUI 状态边界修复方案包

## 目标

把当前散落在 TUI、Task Processor、Finalizer、Workflow、Queue、Reconciler 中的状态写入，收敛为一条可验证的主链：

```text
Execution Runtime
  → Execution Evidence
  → Canonical Decision
  → Task Transition
  → Goal / Queue / Workflow Projection
  → Reconciliation
```

本方案包只描述实施方案，不修改代码。

## 推荐执行顺序

1. `01-canonical-task-transition-kernel.md`
2. `02-unified-execution-contract-and-runtime-boundary.md`
3. `03-tui-runtime-adapter-and-evidence-writeback.md`
4. `04-codex-exec-runtime-and-mcp-tools.md`
5. `05-workflow-queue-auto-advance-convergence.md`
6. `06-reconciliation-migration-observability-release.md`

每份方案完成后都应形成独立、可测试、可回滚的提交。不要并行修改相同核心文件。

## 当前代码事实

当前代码已经出现正确方向的基础设施：

- `backend/src/runtime/task-runtime-aggregate.mjs`
- `backend/src/executions/execution-service.mjs`
- `backend/src/executions/execution-store.mjs`
- `backend/src/codex-tui-evidence-writeback.mjs`
- `backend/src/codex-unified-decision.mjs`
- `backend/src/task-finalizer.mjs`
- `backend/src/closure/task-closure-reconciler.mjs`

但仍有多条直接状态写入路径：

- `backend/src/tool-groups/codex-tui-tools-group.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/runtime-reconciler-stale-tasks.mjs`
- `backend/src/runtime/task-runtime-reconciler.mjs`
- `backend/src/runtime-watch-diagnostics.mjs`
- `backend/src/workflow-state-service.mjs`
- `backend/src/goal-queue.mjs`

核心问题不是缺少状态，而是多个模块都在“决定”状态。

## 最终边界

### Execution Runtime 只负责

- 启动、运行、停止、取消执行
- 记录运行态
- 收集原始日志和产物
- 生成统一 `ExecutionEvidence`
- 不直接决定 Task 最终状态

### Canonical Decision 只负责

- 根据 contract、evidence、verification、integration 产生唯一 `unified_decision`
- 不直接操作队列或启动后续任务

### Task Transition Kernel 只负责

- 校验状态转换
- 原子写入 Task
- 写入 transition history
- 发布标准领域事件
- 不自行重新计算验收结论

### Projection 层只负责

- Goal、Queue、Workflow、Workstream 根据 Task canonical outcome 更新自身投影
- 不覆盖 canonical outcome

### Reconciler 只负责

- 修复“投影与权威状态不一致”
- 不产生新的业务判断
- 所有修复可审计、幂等
