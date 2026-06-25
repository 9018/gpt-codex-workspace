# P0-6 Goal：实现 failure classifier 与 repair retry

## 目标

任务失败时不是直接结束，而是对可修复错误自动 repair 一次；仍失败才进入 `waiting_for_review`。

## 必须新增文件

```text
backend/src/failure-classifier.mjs
backend/src/task-retry.mjs
backend/test/task-retry.test.mjs
```

## failure_class 类型

```text
missing_result_json
invalid_result_json
test_failed
build_failed
lint_failed
typecheck_failed
git_diff_check_failed
no_first_output_timeout
codex_timeout
merge_conflict
unknown
```

## failure-classifier.mjs

导出：

```js
export function classifyTaskFailure({ task, codexResult, verification, error })
```

返回：

```json
{
  "failure_class": "test_failed",
  "repairable": true,
  "reason": "npm test failed",
  "repair_strategy": "rerun_codex_with_failure_logs"
}
```

## task-retry.mjs

导出：

```js
export function canRetryTask(task, failure)
export async function scheduleRepairAttempt({ store, task, goal, failure, verification, config })
export function buildRepairPrompt({ task, goal, failure, verification, diff, logs })
```

## retry 规则

默认：

```json
{
  "attempt": 0,
  "max_attempts": 2
}
```

首次执行 attempt=0。失败后如果 repairable 且 attempt + 1 < max_attempts，创建 repair attempt。

### 各失败类型动作

| failure_class | 动作 |
|---|---|
| missing_result_json | finalizer-only repair，要求只补 result.json |
| invalid_result_json | finalizer-only repair，要求修 JSON 格式 |
| test_failed | repairer 带测试日志和 diff 修代码 |
| build_failed | repairer 带 build 日志修代码 |
| lint/typecheck_failed | repairer 修对应问题 |
| no_first_output_timeout | 短上下文重试一次 |
| codex_timeout | 短上下文或 waiting_for_review |
| merge_conflict | 不自动完成；进入 conflict resolver 或 waiting_for_review |

## 状态流转

```text
running -> failed verification -> repair_scheduled -> assigned/running -> completed
```

或：

```text
running -> failed verification -> max attempts reached -> waiting_for_review
```

## 验收标准

- [ ] 失败能分类。
- [ ] max_attempts 生效。
- [ ] result.json 错误不重新乱改业务代码，只 finalizer repair。
- [ ] 测试失败会产生 repair prompt。
- [ ] repair 后仍失败会 waiting_for_review。
- [ ] 日志里能看到 failure_class、attempt、repair_of_attempt。
