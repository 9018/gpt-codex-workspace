# GOAL-01：真实 Git Worktree Lifecycle 生产化

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-00

## 背景

当前 task-worktree-manager/task-repo-resolution 已经开始真实 git worktree，但存在副作用时机错误、canonical dirty 直接失败、metadata 不完整、失败任务清理过早等交付阻塞点。

## 目标

把 worktree 改成一等任务执行隔离层：task -> repo plan -> materialize worktree -> execute in worktree -> verify in worktree -> cleanup/retain。

## 需要修改/新增的文件

- `backend/src/task-worktree-manager.mjs`
- `backend/src/task-repo-resolution.mjs`
- `backend/src/task-general-processor.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/repo-lock-lifecycle.mjs`
- `backend/test/task-repo-resolution.test.mjs`
- `backend/test/codex-worker-runner-smoke.test.mjs`
- `backend/test/repo-lock.test.mjs`

## 具体实现步骤

1. 拆分 resolveTaskRepositoryPlan 与 materializeTaskWorktree。plan 只解析 repo_id、canonical_repo_path、source_root、target_branch、base_ref、base_sha、task_branch、task_worktree_path、dirty_source、dirty_paths，不执行 git mutation。
2. processGeneralTask 进入 materializing_worktree 后才调用 materializeTaskWorktree。queue/dry-run 阶段严禁调用 git worktree add。
3. canonical repo dirty 默认不阻断：记录 dirty_source=true 和 dirty_paths；只有 GPTWORK_REQUIRE_CLEAN_CANONICAL=true 时才阻断。
4. 创建 worktree 优先使用 base_sha：git worktree add -b gptwork/<task_id> <worktree_path> <base_sha>。分支已存在时支持复用或唯一后缀。
5. worktree_lifecycle metadata 必须包含 mode、ok、source_root、base_ref、base_sha、branch_name、worktree_path、dirty_source、created_at、cleanup_policy。
6. 新增 GPTWORK_WORKTREE_CLEANUP_POLICY=always_remove|remove_on_success_retain_on_failure|always_retain，默认 remove_on_success_retain_on_failure。
7. pruneStaleWorktrees 只清理 terminal+超过 TTL+无 active lock+无 pending repair/integration 的 worktree。

## 验收条件

- queue dry-run 不创建 worktree。
- worker 执行时才创建 worktree。
- canonical dirty 默认不阻断，且 metadata 可见。
- 失败任务默认保留 worktree 和 diff evidence。
- 成功任务按 cleanup policy 清理。
- restart 后能根据 metadata 找回 worktree。

## 建议测试命令

```bash
npm --prefix backend test -- task-repo-resolution
npm --prefix backend test -- codex-worker-runner-smoke
npm --prefix backend test -- repo-lock
npm --prefix backend run check:syntax
```

## 完成定义

多任务执行时，每个 task 都在独立 Git worktree 中运行，queue 阶段无副作用。
