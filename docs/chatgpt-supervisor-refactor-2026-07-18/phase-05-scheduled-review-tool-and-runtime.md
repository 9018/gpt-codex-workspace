# Phase 05：ChatGPT 定时任务高层工具与 Review Runtime

## 1. 目标

让 ChatGPT 定时任务每次只执行一个有界、幂等的监督周期，而不是直接操作底层 TUI 工具。

推荐新增两个公开高层工具：

```text
supervisor_review_active_runs
supervisor_submit_decisions
```

可选第三个：

```text
supervisor_apply_pending_commands
```

生产模式建议 submit 后由服务内 command worker 执行；调试模式允许显式 apply。

## 2. `supervisor_review_active_runs`

职责：

- 找出当前需要审查的 Run。
- 构建或复用 ReviewRequest。
- 返回给 ChatGPT 结构化 Packet。
- 不发送 correction，不改变 controller owner。

输入：

```js
{
  limit: 5,
  run_ids: [],
  include_waiting: true,
  max_packet_bytes: 120000,
}
```

输出：

```js
{
  as_of,
  runs_scanned,
  review_requests_created,
  skipped_unchanged,
  packets: [SupervisorReviewPacket],
}
```

伪代码：

```js
async function reviewActiveRuns(input) {
  const runs = await runSelector.selectReviewable(input);
  const packets = [];

  for (const run of runs) {
    const packet = await packetBuilder.build({ runId: run.id });
    const existing = await requestStore.findByRevision(
      run.id,
      packet.revision.id,
    );

    if (existing?.status === "decided" ||
        existing?.status === "claimed") {
      continue;
    }

    const request = existing ||
      await requestStore.create({ runId: run.id, packet });

    packets.push({ ...packet, review_request_id: request.id });
  }

  return { packets };
}
```

## 3. 哪些 Run 可审查

默认状态：

```text
running
collecting
evaluating
waiting_for_repair
waiting_for_supervisor
```

排除：

- `chatgpt_direct`：已被 ChatGPT 控制，不重复发 review。
- terminal states。
- 无 worktree 且 operation kind 需要 repo mutation 的异常 Run；应先进入 reconciliation。
- `awaiting_progress_after_correction=true` 且 revision 未变化。

审查触发：

```text
首次进入 running
interval 到期
changed files/diff digest 变化
plan node 完成
测试完成
evidence ready
no progress
correction ack 后产生新 progress
显式 waiting_for_supervisor
```

事件触发优先，定时扫描兜底。

## 4. `supervisor_submit_decisions`

输入：

```js
{
  decisions: [SupervisorDecision],
  apply: true,
}
```

处理：

```text
validate schema
 -> verify request and revision
 -> persist immutable decision
 -> action guard
 -> no-op for continue/wait
 -> create durable command for side effects
 -> optionally enqueue command worker
```

输出：

```js
{
  accepted: [{ decision_id, command_id, status }],
  superseded: [{ decision_id, current_revision }],
  rejected: [{ decision_id, error_code, details }],
}
```

批量提交时每个 Decision 独立事务，避免一个错误阻塞全部 Run。

## 5. Tool Group 文件

新增：

```text
backend/src/tool-groups/supervisor-review/
  index.mjs
  supervisor-review-tools.mjs
  supervisor-decision-tools.mjs
  supervisor-command-tools.mjs
  supervisor-review-presenter.mjs
```

工具层只做：

- schema 校验。
- 调用 domain service。
- bounded response。

不得在 handler 中：

- 判断方向。
- 直接 `codex_tui_send`。
- 直接改 Run state。
- 自行拼 takeover 流程。

## 6. ChatGPT 定时任务 Prompt

建议定时任务每 10-15 分钟执行：

```text
调用 supervisor_review_active_runs，最多读取 5 个审查包。
对每个包独立判断是否偏离 architecture_baseline。
测试通过不代表方向正确；重点检查重复状态主权、旁路执行链、
可选 canonical gate、第二套兼容实现、修症状不修根因。
为每个包生成严格符合 SupervisorDecision schema 的决定。
然后调用 supervisor_submit_decisions。
没有 packet 时不要产生通知或动作。
```

调度建议：

- 普通 active Run：10-15 分钟。
- 已 correction 且等待响应：5-10 分钟，但工具会自动跳过未变化 revision。
- 长期 idle：5 分钟。
- 无 active Run：不通知。

## 7. Review Runtime Worker

服务内新增：`supervisor-review-worker.mjs`

职责：

- 回收过期 review claim。
- 将 stale requests 标记 superseded。
- 执行 pending commands。
- reconcile applying commands。
- 监听 Run/TUI events，主动创建 ReviewRequest。

伪代码：

```js
async function tick() {
  await requestStore.reclaimExpired();
  await commandStore.reclaimExpired();
  await reviewReconciler.supersedeStaleRequests();
  await commandReconciler.reconcileApplying();

  const command = await commandStore.claimNext({
    workerId,
    leaseMs: 60_000,
  });

  if (command) await commandExecutor.execute(command);
}
```

## 8. 事件接入

Execution event store 新增或复用事件：

```text
SUPERVISOR_REVIEW_REQUESTED
SUPERVISOR_REVIEW_CLAIMED
SUPERVISOR_DECISION_RECORDED
SUPERVISOR_COMMAND_CREATED
SUPERVISOR_COMMAND_APPLYING
SUPERVISOR_COMMAND_APPLIED
SUPERVISOR_COMMAND_FAILED
CONTROLLER_LEASE_CHANGED
CORRECTION_SENT
CORRECTION_ACKNOWLEDGED
CHATGPT_TAKEOVER_STARTED
CHATGPT_HANDOFF_COMPLETED
```

所有事件包含：

```js
{
  run_id,
  run_version,
  review_revision_id,
  decision_id,
  command_id,
  controller_epoch,
  occurred_at,
}
```

## 9. 可观测性

`runtime_status` 增加：

```js
{
  supervisor_review: {
    enabled,
    worker_running,
    pending_reviews,
    pending_commands,
    applying_commands,
    stale_reviews,
    last_tick_at,
    last_error,
  }
}
```

Run detail 增加：

```js
{
  last_review_revision,
  last_decision,
  active_command,
  controller_owner,
  controller_epoch,
  awaiting_progress_after_correction,
}
```

## 10. 定时任务与事件触发的边界

定时任务：

- 负责调用 ChatGPT。
- 能容忍延迟。
- 适合方向审查。

WorkMCP runtime：

- 负责事件、状态和命令。
- 负责立即暂停、恢复、重试和对账。
- 不依赖 ChatGPT 对话保持在线。

不能让定时任务承担：

- command retry。
- session lease。
- pending 状态。
- 运行锁。
- action acknowledgement。

## 11. Phase 05 测试

- 无 active Run 时返回空 packets。
- 相同 revision 重复扫描不创建新 request。
- 每次最多返回 limit 个 bounded packet。
- submit 旧 revision 返回 superseded，不创建 command。
- `continue_codex` 不产生副作用 command。
- `send_correction` 产生唯一 command。
- 批量 decisions 中单条失败不影响其他条。
- worker 重启可回收 claim。
- runtime status 正确显示 review/command backlog。
- 工具 handler 不直接调用 TUI sender。
