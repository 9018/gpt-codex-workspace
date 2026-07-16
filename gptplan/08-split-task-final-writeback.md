# 08 `task-final-writeback.mjs` 决策与副作用拆分方案

## 目标

把最终一致性逻辑拆成纯决策层和 effect 层；只允许 validated canonical decision 产生 progression commands。

## 目标目录

```text
backend/src/task-finalization/
├── task-finalizer-orchestrator.mjs
├── task-finalization-facts.mjs
├── task-final-state-decider.mjs
├── task-finalization-effects.mjs
├── task-state-projection.mjs
├── goal-state-projection.mjs
├── queue-effect-builder.mjs
├── integration-finalizer.mjs
├── repair-finalizer.mjs
├── worktree-cleanup.mjs
├── finalization-notifier.mjs
├── finalization-proofs.mjs
└── finalization-errors.mjs
```

原文件保留 re-export 门面。

## 实施任务

1. 建立 success、acceptance failure、integration pending、repair creation、no-change、TUI result、writeback failure characterization tests。
2. 提取 `collectTaskFinalizationFacts`，只读输入，返回不可变 facts。
3. 实现纯函数：
   ```js
   decideTaskFinalization(facts) -> UnifiedDecision
   ```
4. 调用 01 方案 validator，invalid 决策立即中断。
5. `buildFinalizationCommands(decision)` 只生成 02 方案 commands。
6. task/goal/queue projection 由 command handler 写入，不在 decider 内写。
7. worktree cleanup 改为单独 command，必须在 integration 和证据持久化后执行。
8. notifier 改为监听 applied command，不参与终态判断。
9. Agent Run writeback failure 使用统一 utility，不在 processor/finalizer 各自实现。
10. repair metadata utility 只保留一个实现。
11. `finalizeCodexTaskRun` 最终仅做：
    ```text
    collect facts
    → decide
    → validate
    → persist decision
    → create commands
    → return receipt
    ```
12. 拆分大测试文件：
    ```text
    backend/test/task-final-writeback/
    ├── fixtures.mjs
    ├── success-path.test.mjs
    ├── acceptance-failure.test.mjs
    ├── integration-propagation.test.mjs
    ├── repair-creation.test.mjs
    ├── no-change-repair.test.mjs
    ├── tui-finalization.test.mjs
    ├── worktree-cleanup.test.mjs
    └── writeback-failure.test.mjs
    ```

## 验收命令

```bash
cd backend
node --test test/task-final-writeback.test.mjs
node --test 'test/task-final-writeback/*.test.mjs'
node --test test/unified-decision-consistency.test.mjs
node --test test/progression-command-e2e.test.mjs
npm run test:state-boundary
npm run check:syntax
npm run check:imports
```

## 完成标准

- 终态决策函数无 I/O。
- finalizer 不直接推进 queue、创建 repair、做 integration 或 cleanup。
- 所有副作用可重试、可审计、幂等。
