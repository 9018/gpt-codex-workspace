# GOAL-10：发布硬化与测试矩阵

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-09

## 背景

前面 goals 完成后，需要系统性测试矩阵防止 worktree、queue、repair、integration、context-index 组合场景回归。

## 目标

建立 release gate：只有通过测试矩阵，才能认为达到用户侧可交付。

## 需要修改/新增的文件

- `backend/test/release-delivery-matrix.test.mjs`
- `backend/scripts/release-delivery-check.mjs`
- `docs/delivery/release-gate.md`
- `backend/package.json`

## 具体实现步骤

1. 新增 release:delivery-check script，组合 check:imports、check:syntax、核心单测、e2e-acceptance、e2e-delivery。
2. 测试矩阵覆盖：单任务基础、worktree、queue、context、acceptance、repair、integration、自愈、用户交付。
3. worktree 测试包含 clean/dirty canonical、branch exists、failed retain、success cleanup、stale prune。
4. acceptance 测试包含 missing tests、missing commit、dirty worktree、docs_only relaxed、runtime change without restart。
5. integration 测试包含 waiting_for_integration、lock serialization、merge conflict repair、integration check failure repair、success completion。
6. 失败输出必须明确模块、原因、next action，不能只给 raw stack。

## 验收条件

- 测试矩阵文档存在。
- release:delivery-check 存在并执行核心测试。
- 失败时输出明确模块和 next action。
- 当前交付功能不依赖手工观察日志才能判断成功。

## 建议测试命令

```bash
npm --prefix backend run check:imports
npm --prefix backend run check:syntax
npm --prefix backend test
npm --prefix backend run test:e2e-acceptance
npm --prefix backend run release:delivery-check
```

## 完成定义

交付前有稳定 release gate，证明多任务、worktree、Zvec、验收、repair、integration 和用户流程全部打通。
