# 07 `task-general-processor.mjs` 行为保持型拆分方案

## 目标

把约 1720 行文件、约 1272 行主函数拆为阶段管线；本方案不改变业务语义。

## 目标目录

```text
backend/src/task-processing/
├── task-general-processor.mjs
├── task-processing-pipeline.mjs
├── task-execution-context.mjs
├── task-worktree-verifier.mjs
├── task-provider-dispatcher.mjs
├── task-execution-runner.mjs
├── task-result-normalizer.mjs
├── task-delivery-recovery.mjs
├── task-healing-controller.mjs
├── task-repair-context.mjs
├── task-processing-errors.mjs
└── task-processing-types.mjs
```

保留原路径 `backend/src/task-general-processor.mjs` 作为兼容 re-export 门面，直到所有 imports 迁移完成。

## 阶段接口

```js
prepareTaskExecution(input) -> PreparedTaskExecution
dispatchTaskProvider(prepared) -> ProviderExecution
collectAndNormalizeResult(execution) -> NormalizedTaskResult
verifyDelivery(result) -> DeliveryVerification
recoverOrRepair(verification) -> RecoveryOutcome
finalizeProcessing(outcome) -> ProcessorOutput
```

## 实施任务

1. 为 `processGeneralTaskWithDeps` 所有主要分支建立 characterization tests。
2. 提取无副作用 helper：
   - TUI normalization。
   - commit evidence normalization。
   - delivery findings 清理。
   - repair context。
3. 提取 worktree 验证模块，保持原错误 code。
4. 提取 execution context，集中 repo/worktree/path/config。
5. 提取 provider dispatcher，只调用统一 ExecutionProvider。
6. 提取 delivery recovery，不再读取 processor 局部变量。
7. 提取 healing controller：
   - retry。
   - park。
   - repair。
   - budget。
8. 将主函数改为显式阶段对象传递，不使用超过 10 个平铺参数。
9. 每提取一个模块即运行对应 characterization tests。
10. 最后把原文件缩到兼容导出和 200–300 行编排。
11. 拆分大测试：
   ```text
   backend/test/task-general-processor/
   ├── fixtures.mjs
   ├── exec-success.test.mjs
   ├── tui-success.test.mjs
   ├── delivery-recovery.test.mjs
   ├── healing-retry.test.mjs
   ├── worktree-validation.test.mjs
   └── failure-classification.test.mjs
   ```
12. 加入 dependency rule，禁止低层模块 import final writeback 或 queue。

## 管线伪代码

```js
export async function processGeneralTaskWithDeps(...args) {
  const prepared = await prepareTaskExecution(toInput(args));
  const execution = await dispatchAndRun(prepared);
  const normalized = await collectAndNormalizeResult(execution);
  const delivery = await verifyTaskDelivery(normalized);
  const outcome = await recoverOrRepair({ prepared, normalized, delivery });
  return buildProcessorOutput(outcome);
}
```

## 验收命令

```bash
cd backend
node --test test/task-general-processor.test.mjs
node --test 'test/task-general-processor/*.test.mjs'
node --test test/codex-tui-chain-regression.test.mjs
node --test test/codex-worker-runner-smoke.test.mjs
npm run check:syntax
npm run check:imports
```

## 完成标准

- 主编排函数不超过 300 行。
- 单个阶段函数原则上不超过 150 行。
- 原测试行为全部保持。
- exec/TUI 仅通过 provider contract 进入。
