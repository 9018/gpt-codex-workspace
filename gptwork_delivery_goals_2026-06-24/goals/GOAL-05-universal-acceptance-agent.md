# GOAL-05：通用自动验收 Agent 与验收 Profile

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-03, GOAL-04

## 背景

当前已有 acceptance-policy、validateResultContract、reviewer_decision、acceptance_findings、repair_proposals，但还没有统一、可配置、可扩展的 verifier/acceptance agent。

## 目标

实现通用验收条件，让任何 Codex task 都必须经过 evidence-based acceptance，只有通过验收才可进入 integration/completed。

## 需要修改/新增的文件

- `backend/src/acceptance-policy.mjs`
- `backend/src/task-result-status.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/acceptance-agent.mjs`
- `backend/src/verification-evidence.mjs`
- `backend/test/acceptance-policy.test.mjs`
- `backend/test/acceptance-agent.test.mjs`

## 具体实现步骤

1. 新增 acceptance profiles：default、code_change、docs_only、config_change、deploy、noop，每个 profile 可覆盖 required checks。
2. 新增 runAcceptanceAgent({ task, goal, result, repoPath, profile, evidence })，返回 passed/status/findings/repair_proposals/next_tasks/evidence。
3. 新增 evidence builder：git status、diff summary、commit exists、changed files from git、verification log、result parse status、safe restart marker。
4. 通用验收：result.json valid、summary present、verification commands for non-noop、verification passed、changed_files safe、changed_files match git、commit/patch evidence、worktree clean、runtime restart evidence、blocker/major=0。
5. finalizer 映射：acceptance failed -> waiting_for_repair；cannot auto repair -> waiting_for_review；passed code task -> waiting_for_integration。
6. 保持 reviewer_decision 兼容，但由新的 acceptance agent 生成。

## 验收条件

- 所有 completed task 都经过 acceptance agent。
- blocker/major findings 会阻止 completed。
- docs_only/noop 可通过更宽松 profile。
- runtime change without restart 会进入 waiting_for_repair 或 waiting_for_review。
- 测试覆盖 default/code_change/docs_only/noop/deploy profiles。

## 建议测试命令

```bash
npm --prefix backend test -- acceptance
npm --prefix backend test -- task-result-status
npm --prefix backend run check:syntax
```

## 完成定义

任务从 Codex 自报 completed 改为 Codex 完成 + evidence 通过 + acceptance agent 通过。
