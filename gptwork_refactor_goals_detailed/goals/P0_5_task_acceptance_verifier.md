# P0-5 Goal：实现独立 task acceptance/verifier

## 目标

任务不能只凭 Codex 自报 `completed` 就完成。必须有独立 verifier 做硬验收，生成 `verification.json`。

## 必须新增文件

```text
backend/src/task-acceptance.mjs
backend/test/task-acceptance.test.mjs
```

## 必须实现函数

```js
export async function verifyTaskCompletion({
  task,
  goal,
  repoPath,
  resultJson,
  resultJsonPath,
  workspaceFiles,
  config,
  stateStore,
  logger
})
```

## 验收逻辑

### 1. result.json 检查

必须检查：

- 文件存在。
- JSON 合法。
- `status` 是 `completed|failed|waiting_for_review`。
- 如果 `status=completed`，必须有 `summary`。
- 如果有代码修改，必须有 `changed_files`。
- 如果无修改，必须声明 `noop_reason` 或类似字段。
- 如果 `status=completed`，必须有 `verification.passed === true` 或独立 verifier 自己跑出的验证通过。

### 2. Git 检查

必须运行：

```bash
git diff --check
```

在 task repo path / worktree path 内执行。

### 3. 自动发现测试命令

按项目实际文件发现：

| 条件 | 命令 |
|---|---|
| package.json 有 test | npm test 或 npm run test |
| package.json 有 build | npm run build |
| package.json 有 typecheck | npm run typecheck |
| package.json 有 lint | npm run lint |
| pytest 配置/pyproject | python -m pytest 或 pytest |
| go.mod | go test ./... |
| Cargo.toml | cargo test |
| pom.xml | mvn test |

命令不存在不应直接失败，应该记录 skipped；但至少 `git diff --check` 必须执行。

### 4. 输出 verification.json

格式：

```json
{
  "passed": true,
  "status": "completed",
  "failure_class": null,
  "requires_review": false,
  "commands": [
    {
      "cmd": "git diff --check",
      "exit_code": 0,
      "stdout_tail": "",
      "stderr_tail": ""
    }
  ],
  "changed_files": [],
  "reason_no_tests": null,
  "verified_at": "..."
}
```

## 完成判定

只有以下条件满足才能 completed：

```text
result.json 合法
AND result.status == completed
AND verification.passed == true
AND git diff --check passed
AND 测试/构建命令通过或明确 reason_no_tests
```

## 验收标准

- [ ] `task-acceptance.mjs` 存在。
- [ ] 能生成 `verification.json`。
- [ ] `verification.passed !== true` 时不能 completed。
- [ ] `git diff --check` 失败时不能 completed。
- [ ] result.json 缺失/格式错返回 failure_class。
- [ ] 单元测试覆盖成功、缺 result、格式错、测试失败、无测试系统 fallback。
