# P0-1 Goal：实现 per-task git worktree service

## 目标

新增 `backend/src/worktree-service.mjs`，为每个普通代码 task 创建独立 git worktree 和 branch。这个模块是后续多任务并发的基础。

## 必须新增文件

```text
backend/src/worktree-service.mjs
backend/test/worktree-service.test.mjs
```

## 必须实现导出函数

```js
export async function resolveGitRoot(repoPath)
export async function getGitHeadSha(repoPath, ref = 'HEAD')
export async function createTaskWorktree({ repoPath, taskId, baseRef, worktreesRoot, logger })
export async function removeTaskWorktree({ repoPath, worktreePath, logger, force = true })
export async function getWorktreeHeadSha({ worktreePath })
export async function checkWorktreeDirty({ worktreePath })
export async function checkMergeability({ repoPath, worktreeBranch, baseRef })
export function defaultTaskBranch(taskId)
export function defaultTaskWorktreePath({ workspaceRoot, taskId })
```

## 实现细节

### 1. branch 命名

```text
gptwork/task/<task_id>
```

必须对 task id 做基本安全处理：只允许字母、数字、`_`、`-`，其他字符替换成 `-`。

### 2. worktree path

默认：

```text
<workspaceRoot>/.gptwork/worktrees/<task_id>
```

如果调用方显式传 `worktreesRoot`，使用：

```text
<worktreesRoot>/<task_id>
```

### 3. 创建流程

伪代码：

```js
const gitRoot = await resolveGitRoot(repoPath)
const baseSha = await getGitHeadSha(gitRoot, baseRef || 'HEAD')
const branch = defaultTaskBranch(taskId)
const worktreePath = defaultTaskWorktreePath(...)

// 先检查 path/branch 是否已存在
// 可幂等返回已存在 worktree，也可明确报错，但错误必须清晰。

await git(gitRoot, ['worktree', 'add', '-b', branch, worktreePath, baseSha])

return {
  enabled: true,
  path: worktreePath,
  branch,
  base_ref: baseRef || 'HEAD',
  base_sha: baseSha,
  head_sha: baseSha,
  status: 'created'
}
```

### 4. dirty check

`checkWorktreeDirty` 必须运行：

```bash
git status --porcelain
```

返回：

```js
{ dirty: boolean, files: string[] }
```

### 5. mergeability check

MVP 不要求自动 merge main，但要支持 clean/conflict 检查。可以用以下任一方式：

```bash
git merge-tree <base_sha> <base_ref> <worktree_branch>
```

或创建临时检查 worktree 做 `git merge --no-commit --no-ff`。

返回：

```js
{ merge_status: 'clean' | 'conflict' | 'unknown', details: string }
```

## 测试要求

`backend/test/worktree-service.test.mjs` 至少覆盖：

1. 能在临时 git repo 中创建 worktree。
2. branch 名符合 `gptwork/task/<task_id>`。
3. worktree path 存在。
4. `checkWorktreeDirty` 能检测 dirty 文件。
5. `removeTaskWorktree` 能清理。
6. 非 git repo 给清晰错误。

## 验收标准

- [ ] `backend/src/worktree-service.mjs` 存在。
- [ ] `createTaskWorktree` 实际执行 `git worktree add`。
- [ ] 返回对象包含 `path/branch/base_ref/base_sha/head_sha/status`。
- [ ] 测试能独立运行。
- [ ] 没有只写 stub 或 TODO。
