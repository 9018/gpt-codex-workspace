# Phase 02：Durable Review、Command Store、幂等与 Controller Lease

## 1. 为什么必须先做持久化

ChatGPT 定时任务会重复运行；服务也可能在“Decision 已产生、但 correction 尚未发送”之间重启。若只把 action 保存在内存或 Run 的几个计数字段中，会出现：

- 同一 correction 重复发送。
- Decision 丢失。
- TUI 已执行但 WorkMCP 认为未执行。
- takeover 执行一半后双写。
- 新 revision 已产生，旧命令仍被执行。

因此必须分开保存：

```text
ReviewRequest：等待 ChatGPT 判断
SupervisorDecision：ChatGPT 给出的不可变判断
SupervisorCommand：准备执行或已经执行的副作用
```

## 2. Review Request Store

新增：`supervisor-review-request-store.mjs`

```js
export const REVIEW_REQUEST_STATES = [
  "pending",
  "claimed",
  "decided",
  "superseded",
  "failed",
];

export function createReviewRequest({ runId, packet }) {
  return {
    id: `review_${packet.revision.id}`,
    run_id: runId,
    revision_id: packet.revision.id,
    packet,
    status: "pending",
    claim_owner: null,
    claim_expires_at: null,
    decision_id: null,
    attempts: 0,
    created_at: now(),
    updated_at: now(),
  };
}
```

唯一约束：`UNIQUE(run_id, revision_id)`。

## 3. Decision Store

新增：`supervisor-decision-store.mjs`

- Decision 一旦保存不可修改。
- 同一 request 只允许一个 active decision。
- 后续改变只能新建 decision 并将旧 decision 标记 superseded，但保留审计记录。
- 保存前必须再次读取当前 review revision。

伪代码：

```js
async function recordDecision(input) {
  const decision = normalizeSupervisorDecision(input);
  return stateStore.transaction(async (state) => {
    const request = findRequest(state, decision.review_revision_id);
    if (!request) throw new Error("review request not found");
    if (request.status === "superseded") {
      throw new StaleReviewDecisionError();
    }

    const currentRevision = await revisionReader.current(request.run_id);
    if (currentRevision.id !== decision.review_revision_id) {
      request.status = "superseded";
      throw new StaleReviewDecisionError();
    }

    state.supervisor_decisions.push(decision);
    request.status = "decided";
    request.decision_id = decision.id;
    return structuredClone(decision);
  });
}
```

## 4. Command Schema

新增：`supervisor-command-schema.mjs`

```js
export const COMMAND_STATES = [
  "pending",
  "claimed",
  "applying",
  "applied",
  "retryable_failed",
  "terminal_failed",
  "superseded",
];

export function commandFromDecision(decision, run) {
  const idempotencyKey = [
    run.id,
    decision.review_revision_id,
    decision.action,
  ].join(":");

  return {
    id: crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    run_id: run.id,
    decision_id: decision.id,
    review_revision_id: decision.review_revision_id,
    action: decision.action,
    payload: buildCommandPayload(decision),
    preconditions: {
      expected_run_version: run.version,
      expected_controller_owner:
        run.supervision?.controller_owner || "workmcp_autopilot",
      expected_worktree_path: run.workspace_ref?.worktree_path || null,
      expected_session_id: run.active_session_id || null,
      expected_native_session_id: run.native_session_id || null,
    },
    status: "pending",
    attempt: 0,
    claimed_by: null,
    claim_expires_at: null,
    result: null,
    failure: null,
    created_at: now(),
    updated_at: now(),
  };
}
```

唯一约束：`UNIQUE(idempotency_key)`。

## 5. Command Store API

```js
createFromDecision()
readCommand()
claimNext({ workerId, leaseMs })
markApplying()
markApplied(result)
markRetryableFailure(failure, retryAt)
markTerminalFailure(failure)
markSuperseded(reason)
listPendingByRun(runId)
reclaimExpired()
```

必须使用 CAS 或事务：

```js
async function claimNext({ workerId, now, leaseMs }) {
  return stateStore.transaction((state) => {
    const command = selectOldestClaimable(state, now);
    if (!command) return null;

    command.status = "claimed";
    command.claimed_by = workerId;
    command.claim_expires_at = addMs(now, leaseMs);
    command.attempt += 1;
    return structuredClone(command);
  });
}
```

## 6. Controller Lease

新增：`supervisor-controller-lease.mjs`

Owner 枚举：

```text
codex_active
codex_quiescing
chatgpt_supervising
chatgpt_direct
handoff_to_codex
none
```

Lease：

```js
{
  run_id,
  owner,
  holder_id,
  epoch,
  acquired_at,
  expires_at,
  worktree_path,
  session_id,
  native_session_id,
}
```

规则：

- 每次 ownership 变化增加 `epoch`。
- 所有写动作必须携带 expected epoch。
- lease 到期不等于立即允许另一个 owner 写；必须先执行 quiescence reconciliation。
- ChatGPT takeover 不得直接从 `codex_active` 跳到 `chatgpt_direct`。

合法状态转换：

```text
codex_active -> codex_quiescing -> chatgpt_supervising -> chatgpt_direct
chatgpt_direct -> handoff_to_codex -> codex_active
任何状态 -> none（仅在确认无写进程后）
```

## 7. Action Guard

将 `supervisor-policy-engine` 收敛为 action guard：

```js
function validateCommand({ command, run, lease, currentRevision, plan }) {
  assert(command.review_revision_id === currentRevision.id);
  assert(command.preconditions.expected_run_version <= run.version);
  assertWithinBudget(command, run.supervision, plan.autonomy_budget);
  assertAllowedActionForRunState(command.action, run.state);
  assertControllerPreconditions(command.action, lease);
  assertNoConflictingCommand(command.run_id);
}
```

注意：`continue_codex` 也应记录为 Decision，但通常不创建副作用 Command；只更新 review request 为 decided，并等待新 revision。

## 8. Command Executor

新增：`supervisor-command-executor.mjs`

```js
export function createSupervisorCommandExecutor(deps) {
  async function execute(command) {
    const run = await deps.runStore.readRun(command.run_id);
    const currentRevision = await deps.revisionReader.current(run.id);

    deps.actionGuard.validateCommand({
      command,
      run,
      currentRevision,
      lease: await deps.leaseStore.read(run.id),
      plan: await deps.planStore.readPlan(run.supervisor_plan_id),
    });

    await deps.commandStore.markApplying(command.id);

    try {
      const result = await route(command, run);
      await deps.commandStore.markApplied(command.id, result);
      await deps.audit.append({ type: "supervisor_command_applied", command, result });
      return result;
    } catch (error) {
      const failure = deps.failureClassifier.classify(error);
      if (failure.retryable) {
        await deps.commandStore.markRetryableFailure(command.id, failure);
      } else {
        await deps.commandStore.markTerminalFailure(command.id, failure);
      }
      throw error;
    }
  }

  async function route(command, run) {
    switch (command.action) {
      case "send_correction":
        return deps.tuiCorrectionService.apply(command, run);
      case "pause_codex":
        return deps.quiescenceService.pause(command, run);
      case "chatgpt_takeover":
        return deps.takeoverService.apply(command, run);
      case "evaluate_terminal":
        return deps.terminalService.evaluate(command, run);
      case "wait":
        return { no_op: true };
      default:
        throw new Error(`unsupported command action: ${command.action}`);
    }
  }

  return { execute };
}
```

## 9. 修改当前代码

### `checkpoint-supervisor-loop.mjs`

删除：

- 直接调用 acceptance service 生成动作。
- 自己维护 action 字符串。
- 吞掉 updateRun 错误。

改为：

```js
async function tick(runId) {
  const packet = await reviewPacketBuilder.build({ runId });
  const request = await reviewRequestStore.getOrCreate({ runId, packet });
  return { review_required: request.status === "pending", request };
}
```

### `checkpoint-acceptance-service.mjs`

第一阶段保留 facade，但不再被 supervisor loop 调用。后续仅用于 deterministic evidence acceptance。

## 10. Phase 02 测试

- 同一 run/revision 只能有一个 ReviewRequest。
- 同一 decision/action 只能有一个 Command。
- 两个 worker 同时 claim 只成功一个。
- claim 到期可回收。
- command applied 后服务重启不会重复执行。
- revision 变化使 pending command superseded。
- controller epoch 不匹配时拒绝写操作。
- takeover 未经过 quiescing 时拒绝。
- action budget 耗尽后 command 进入 terminal_failed，而不是无限重试。
