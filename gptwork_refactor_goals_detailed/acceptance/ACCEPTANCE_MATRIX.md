# 最终验收矩阵

## A. 必须存在的文件

| 文件 | 必须 | 状态 |
|---|---:|---|
| `backend/src/worktree-service.mjs` | 是 | 待验收 |
| `backend/src/task-acceptance.mjs` | 是 | 待验收 |
| `backend/src/failure-classifier.mjs` | 是 | 待验收 |
| `backend/src/task-retry.mjs` | 是 | 待验收 |
| `backend/test/worktree-service.test.mjs` | 是 | 待验收 |
| `backend/test/task-acceptance.test.mjs` | 是 | 待验收 |
| `backend/test/multi-task-flow.test.mjs` 或等价测试 | 是 | 待验收 |

## B. 代码行为验收

| 验收点 | 通过标准 |
|---|---|
| worktree 创建 | 3 个普通 task 产生 3 个不同 worktree path |
| branch 隔离 | branch 为 `gptwork/task/<task_id>` |
| worker cwd | Codex 执行 cwd 为 `task.worktree.path` |
| repo lock | builder task 不在整个执行期持有 canonical repo lock |
| deploy/admin | 仍受 canonical repo lock 保护 |
| result.json | completed task 必须有合法 result.json |
| verification.json | completed task 必须有 verification.json |
| verification.passed | false 时不得 completed |
| git diff | 必须运行 `git diff --check` |
| tests | 有测试命令就运行；没有要有 reason_no_tests |
| retry | test/result/timeout 类失败至少自动 repair 一次 |
| queue sync | task 完成后 queue item 同步完成/失败/review |
| auto start | task 完成后触发下一项 auto start |
| context | bundle 有 retrieval source list |

## C. 一票否决项

出现任一情况，判定未完成：

1. 没有 `worktree-service.mjs`。
2. 没有 `task-acceptance.mjs`。
3. 普通 builder 任务仍全程占用 canonical repo lock。
4. Codex cwd 仍是 `config.defaultRepoPath`。
5. 没有独立 verifier，只相信 Codex 自报 completed。
6. `verification.passed=false` 仍标 completed。
7. 没有三任务 worktree 测试/demo。
8. 只改 README/文档。
9. 只做 restart marker/recovery unrelated work。

## D. 建议运行命令

```bash
cd backend
npm run check:syntax
npm run check:imports
npm test
node --test --test-reporter=dot test/worktree-service.test.mjs
node --test --test-reporter=dot test/task-acceptance.test.mjs
node --test --test-reporter=dot test/multi-task-flow.test.mjs
```

如果某些测试文件名不同，执行等价测试，但必须说明覆盖关系。
