# 11 全链路故障注入、E2E 与发布门禁方案

## 目标

用可重复的故障注入证明“无人值守全自动链路”在重启、重复、断连、缺失和部分成功场景下仍能收敛。

## 新增

- `backend/test/helpers/fault-injection-harness.mjs`
- `backend/test/helpers/fake-codex-exec-provider.mjs`
- `backend/test/helpers/fake-codex-tui-provider.mjs`
- `backend/test/helpers/fake-tui-screen-sequences.mjs`
- `backend/test/e2e-autonomous-tui-closure.test.mjs`
- `backend/test/e2e-provider-failover.test.mjs`
- `backend/test/e2e-restart-recovery.test.mjs`
- `backend/test/e2e-progression-idempotency.test.mjs`
- `backend/test/e2e-state-reconciliation.test.mjs`
- `backend/test/e2e-multi-agent-dag.test.mjs`
- `backend/scripts/autonomous-runtime-release-gate.mjs`

## 必测故障矩阵

### 执行阶段

- exec 无首输出。
- exec 有输出但无内容进展。
- exec result.json 缺失。
- TUI 首屏超时。
- TUI 重复确认循环。
- TUI 返回 prompt 但任务未完成。
- TUI PTY 断开。
- TUI native session 可 resume。
- provider 切换期间服务重启。

### 证据与验收

- 代码已改但 result 缺失。
- result 声称成功但测试失败。
- acceptance passed 但 integration 未完成。
- integration 成功但写回失败。
- contradictory unified decision。
- stale evidence revision。

### 推进

- command 创建后服务崩溃。
- effect 成功但 markApplied 前崩溃。
- 同一事件重复到达。
- 两个 worker 同时 claim。
- repair task 创建成功但父任务写回失败。
- repair 完成后父任务重归并失败。
- queue advance 重复执行。

### 状态恢复

- task running、PID 消失。
- TUI session running、PTY 不可附着。
- completed decision、projection 未完成。
- worktree 已集成但 cleanup 未执行。
- stale command lease。

## 断言

每个场景都必须断言：

```text
没有重复副作用
没有假完成
没有永久 waiting
最终状态可解释
命令和事件可追溯
任务/目标/队列/workstream 一致
```

## Release Gate

新增脚本执行：

1. syntax/import。
2. canonical decision invariant suite。
3. progression command suite。
4. autonomous TUI suite。
5. provider contract/failover suite。
6. state boundary suite。
7. full npm test。
8. E2E canary。
9. 输出 JSON 报告。

报告：

```js
{
  git_head,
  passed,
  suites,
  invariants,
  autonomous_tui,
  recovery,
  idempotency,
  state_consistency,
  failures
}
```

## 验收命令

```bash
cd backend
npm run check:syntax
npm run check:imports
npm run test:state-boundary
node --test test/e2e-autonomous-tui-closure.test.mjs
node --test test/e2e-provider-failover.test.mjs
node --test test/e2e-restart-recovery.test.mjs
node --test test/e2e-progression-idempotency.test.mjs
node --test test/e2e-state-reconciliation.test.mjs
node --test test/e2e-multi-agent-dag.test.mjs
npm test
node scripts/autonomous-runtime-release-gate.mjs
```

## 完成标准

- 所有故障场景自动收敛或明确终止。
- 不存在无限 waiting。
- 不存在 required integration 未完成却 completed。
- TUI canary 无人工输入。
