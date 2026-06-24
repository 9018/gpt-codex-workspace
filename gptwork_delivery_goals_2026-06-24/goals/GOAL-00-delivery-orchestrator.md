# GOAL-00：交付级多任务系统总编排

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

无

## 背景

当前系统已有 goal/task/worker、repo registry、repo lock、context-index、Codex result parser、safe restart、GitHub sync 等模块，但还没有形成用户可交付的多任务闭环。本 goal 先落地总状态机、接口契约、文档边界和后续 goals 的依赖关系。

## 目标

建立统一交付架构：ChatGPT request -> create_encoded_goal -> context bundle -> queue scheduling -> task worktree materialization -> Codex execution -> verifier agent -> acceptance agent -> repair loop -> integration queue -> final completion / notification。

## 需要修改/新增的文件

- `docs/delivery/multi-task-delivery-architecture.md`
- `docs/delivery/task-state-machine.md`
- `docs/delivery/context-and-worktree-contract.md`
- `docs/delivery/acceptance-and-repair-contract.md`
- `backend/src/delivery-contracts.mjs`
- `backend/test/delivery-contracts.test.mjs`

## 具体实现步骤

1. 定义任务生命周期：created、queued、waiting_for_dependency、waiting_for_lock、materializing_worktree、assigned、running、verifying、waiting_for_repair、repairing、waiting_for_integration、integrating、completed、failed、waiting_for_review、cancelled。
2. 定义 goal/task/result 最小交付契约：task 必须绑定 goal_id；执行 task 必须有 repo_resolution；启用 worktree 后必须有 worktree_lifecycle；completed 必须有 verification/reviewer_decision；changed_files 非空必须有 commit 或 patch evidence。
3. 把契约写成纯函数/常量，供 parser、finalizer、acceptance、test 复用，不要散落在多个模块里。
4. 写 delivery docs，明确 GOAL-01 到 GOAL-10 的执行顺序、依赖关系和不可并行点。

## 验收条件

- docs/delivery/* 存在且与代码状态机一致。
- backend/src/delivery-contracts.mjs 提供状态常量、schema、状态转换 helper。
- 单测覆盖合法/非法状态、completed 必填字段、repair/integration 状态转换。
- 不破坏现有 MCP 工具兼容性。

## 建议测试命令

```bash
npm --prefix backend test -- delivery-contracts
npm --prefix backend run check:syntax
```

## 完成定义

交付架构契约已落地，后续 goals 可以按 dependency graph 串行/并行下发。
