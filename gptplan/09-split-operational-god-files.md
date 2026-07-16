# 09 工具组、Queue、Patrol、Retention God File 拆分方案

## 目标

拆分高耦合生产文件，改善工具按需发现、并行开发、测试隔离和故障定位。

## A. Recovery Tool Group

目标目录：

```text
backend/src/tool-groups/recovery/
├── index.mjs
├── common.mjs
├── file-tools.mjs
├── patch-tools.mjs
├── command-tools.mjs
├── lock-tools.mjs
├── queue-tools.mjs
├── worker-tools.mjs
├── runtime-tools.mjs
├── restart-tools.mjs
├── storage-tools.mjs
└── api-tools.mjs
```

每个模块输出：

```js
{ definitions, handlers }
```

`index.mjs` 只合并和检测重名。

## B. Workflow Tool Group

```text
backend/src/tool-groups/workflow/
├── index.mjs
├── status-tools.mjs
├── result-tools.mjs
├── advance-tools.mjs
└── proposal-tools.mjs
```

handler 只做参数校验和 domain service 调用。

## C. Goal Queue

```text
backend/src/goal-queue/
├── queue-store.mjs
├── dependency-policy.mjs
├── eligibility-policy.mjs
├── repo-guard.mjs
├── queue-starter.mjs
├── auto-advance.mjs
└── queue-service.mjs
```

`checkTypedEligibility` 成为纯 policy。

## D. Runtime Patrol

```text
backend/src/runtime/patrol/
├── stalled-task-rule.mjs
├── state-classification-rule.mjs
├── blocker-rule.mjs
├── evidence-rule.mjs
├── dirty-repo-rule.mjs
├── afc-rule.mjs
├── patrol-runner.mjs
└── patrol-report.mjs
```

rule 只输出 finding/progression command proposal。

## E. Retention

```text
backend/src/retention/
├── config.mjs
├── inventory.mjs
├── scanners/task-scanner.mjs
├── scanners/goal-scanner.mjs
├── scanners/worktree-scanner.mjs
├── scanners/event-scanner.mjs
├── scanners/temp-scanner.mjs
├── policy.mjs
├── plan-builder.mjs
├── cleanup-executor.mjs
├── audit.mjs
└── service.mjs
```

严格分离：

```text
scan facts → policy decision → dry-run plan → explicit executor
```

executor 不得重新推断策略。

## F. Onboarding

```text
backend/src/onboarding/
├── checks/runtime-checks.mjs
├── checks/git-checks.mjs
├── checks/codex-checks.mjs
├── checks/workspace-checks.mjs
├── checks/context-checks.mjs
├── init-runner.mjs
├── fix-runner.mjs
├── report-renderer.mjs
└── templates.mjs
```

## 执行方法

每个子项目独立 worktree、独立 PR，可并行执行。每个子项目步骤一致：

1. Characterization tests。
2. Extract module，不改行为。
3. 原路径保留门面。
4. 迁移 imports。
5. 对比工具名称、schema digest 和输出。
6. 删除重复 helper。
7. 运行定向测试。
8. 单独提交。

## 验收命令

```bash
cd backend
node --test test/workflow-tools-group.test.mjs
node --test test/goal-queue.test.mjs
node --test test/retention-service.test.mjs test/retention-productization.test.mjs
node --test test/runtime-watch-diagnostics.test.mjs
node --test test/onboarding-init.test.mjs
npm run check:syntax
npm run check:imports
```

## 完成标准

- 工具注册工厂不含复杂业务决策。
- retention 扫描、策略、执行完全分离。
- queue eligibility 可纯函数单测。
- patrol 不再直接跨域改状态。
