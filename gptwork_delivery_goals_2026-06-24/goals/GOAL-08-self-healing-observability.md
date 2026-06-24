# GOAL-08：任务执行自愈与可观测性

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-01, GOAL-03, GOAL-06

## 背景

已有 heartbeat、run logs、repo lock reconciler、safe restart marker、tmp cleanup、goal cleanup，但还未统一成任务自愈策略。

## 目标

常见运行错误优先自动恢复；无法恢复时进入明确状态，并提供 error_code、evidence、next_action，不再长期卡住。

## 需要修改/新增的文件

- `backend/src/codex-run-heartbeat.mjs`
- `backend/src/codex-run-metadata.mjs`
- `backend/src/codex-worker-loop.mjs`
- `backend/src/runtime-reconciler.mjs`
- `backend/src/repo-lock-reconciler.mjs`
- `backend/src/gptwork-tmp.mjs`
- `backend/src/worker-maintenance.mjs`
- `backend/src/self-healing-policy.mjs`
- `backend/test/self-healing-policy.test.mjs`

## 具体实现步骤

1. ENOSPC/tmp 写失败：cleanup_tmp dry-run -> safe cleanup apply -> retry prompt write once -> 仍失败则 operational_error。
2. no first output timeout：记录 no_first_output_timeout -> 构建 smaller context bundle -> compact retry once -> 仍失败 waiting_for_review/failed。
3. stale repo lock：reconcileRepoLocks -> stale archive/release -> retry waiting_for_lock task。
4. worker crash during running：runtime reconciler 扫 running task；无 heartbeat 且 child pid dead -> timed_out/stale_running；worktree 存在则 preserve 并创建 recovery/repair task。
5. result.json missing：stdout parser -> last message parser -> fallback result.json；无证据则 waiting_for_repair。
6. safe restart interrupted：restart marker verifier；commit 匹配则 finalize，否则 waiting_for_review with restart mismatch evidence。
7. 每个 run 必须有 metadata/stdout/stderr/execution-log/verification.log/implementation-diff.patch。

## 验收条件

- running stale task 可被 reconciler 转为可解释状态。
- ENOSPC 能触发 cleanup retry。
- no first output 能触发 compact retry。
- stale lock 不会永久阻塞队列。
- 每个失败都有 error_code、evidence、next_action。

## 建议测试命令

```bash
npm --prefix backend test -- self-healing
npm --prefix backend test -- runtime-reconciler
npm --prefix backend test -- codex-run-metadata
npm --prefix backend run check:syntax
```

## 完成定义

系统出现常见运行错误时优先自动修复，无法修复时也有足够证据给用户/人工处理。
