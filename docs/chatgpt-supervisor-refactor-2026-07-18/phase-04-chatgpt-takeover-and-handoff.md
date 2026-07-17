# Phase 04：ChatGPT Takeover、Project Control 与安全交还

## 1. 目标

让 ChatGPT 能在 correction 无法收敛时修改同一 worktree，并在完成后交还 Codex。核心不是“增加几个工具”，而是建立严格的 controller ownership protocol。

## 2. Takeover 状态机

```text
codex_active
 -> codex_quiescing
 -> chatgpt_supervising
 -> chatgpt_direct
 -> handoff_to_codex
 -> codex_active
```

失败状态：

```text
quiescence_failed
chatgpt_takeover_blocked
handoff_validation_failed
```

不要直接：

```text
running -> chatgpt_direct
```

## 3. Quiescence Service

新增：`supervisor-review/codex-quiescence-service.mjs`

```js
export function createCodexQuiescenceService(deps) {
  async function quiesce({ run, command }) {
    const lease = await deps.leaseStore.compareAndSetOwner({
      runId: run.id,
      expectedOwner: "codex_active",
      nextOwner: "codex_quiescing",
    });

    const before = await deps.repositorySnapshot.capture(run);

    await deps.provider.interrupt({
      attemptId: run.active_attempt_id,
      mode: "checkpoint_and_pause",
      reason: command.payload.reason,
    });

    await deps.processProbe.waitForNoWriter({
      runId: run.id,
      worktreePath: run.workspace_ref.worktree_path,
      timeoutMs: 30_000,
    });

    const stable1 = await deps.repositorySnapshot.capture(run);
    await deps.clock.sleep(1_500);
    const stable2 = await deps.repositorySnapshot.capture(run);

    if (stable1.diff_digest !== stable2.diff_digest ||
        stable1.head_sha !== stable2.head_sha) {
      throw new WorktreeStillChangingError(run.id);
    }

    await deps.checkpointService.createTakeoverCheckpoint({
      run,
      command,
      before,
      stable: stable2,
    });

    return deps.leaseStore.compareAndSetOwner({
      runId: run.id,
      expectedOwner: "codex_quiescing",
      expectedEpoch: lease.epoch,
      nextOwner: "chatgpt_supervising",
    });
  }

  return { quiesce };
}
```

## 4. 改造 `supervisor-takeover-service`

当前服务直接改变 Run state。改造后：

```js
async function takeover({ command, runId }) {
  let run = await runStore.readRun(runId);

  const quiescence = await quiescenceService.quiesce({ run, command });
  const packet = await takeoverContextBuilder.build({ runId, command });

  run = await runStore.compareAndSetState({
    runId,
    expectedState: run.state,
    nextState: "chatgpt_direct",
    patch: {
      supervision: {
        ...run.supervision,
        controller_owner: "chatgpt_direct",
        controller_epoch: quiescence.epoch,
        takeover_command_id: command.id,
        takeover_base_sha: packet.repository.head_sha,
        takeover_diff_digest: packet.repository.diff_digest,
        chatgpt_takeover_count:
          (run.supervision?.chatgpt_takeover_count || 0) + 1,
      },
    },
  });

  return { run, context_packet: packet };
}
```

所有 `catch { /* optional */ }` 应转换为显式 diagnostics。Plan/checkpoint 可以缺失，但缺失必须在 packet 中列为 evidence gap，不能静默忽略。

## 5. Project Control Context

当前 `tool-groups/project-control/*` 已按 read/search/diff/patch/test/command/takeover/audit 拆分，方向正确。所有写工具必须强制调用：

```js
assertChatGPTDirectControl({
  runId,
  controllerEpoch,
  worktreePath,
  requestedPath,
})
```

不变量：

- Run state 必须为 `chatgpt_direct`。
- lease owner 必须为 `chatgpt_direct`。
- caller epoch 必须等于当前 epoch。
- 所有路径必须在 Run worktree 内。
- 禁止修改 canonical repo 或其他 retained worktree。
- 命令 cwd 固定为 Run worktree。
- command allowlist 由 operation profile 和 takeover decision 共同决定。

## 6. Takeover Context Packet

```js
{
  run,
  decision,
  review_revision,
  goal,
  plan,
  architecture_baseline,
  repository: {
    worktree_path,
    base_sha,
    head_sha,
    diff_digest,
    dirty_paths,
    focused_diff,
  },
  verification,
  tui: {
    native_session_id,
    last_progress,
    last_log_excerpt,
  },
  constraints: {
    allowed_files,
    forbidden_changes,
    required_commands,
    return_conditions,
  },
  controller_epoch,
}
```

## 7. ChatGPT 修改流程

```text
project_read/search
 -> project_diff
 -> project_patch
 -> project_test / allowlisted command
 -> project_diff
 -> create ChatGPTWorkReceipt
 -> request handoff
```

ChatGPTWorkReceipt：

```js
{
  schema_version: 1,
  run_id,
  takeover_command_id,
  controller_epoch,
  base_sha,
  final_head_sha,
  changed_files,
  commands: [{ command, cwd, exit_code, output_ref }],
  tests,
  unresolved_findings,
  recommended_next_action,
  created_at,
}
```

自然语言“已经修好”不能代替 Receipt。

## 8. Handoff to Codex

新增：`supervisor-review/handoff-to-codex-service.mjs`

```js
async function handoff({ runId, receipt }) {
  let run = await runStore.readRun(runId);
  assert(run.state === "chatgpt_direct");
  assert(receipt.controller_epoch === run.supervision.controller_epoch);

  await receiptVerifier.verify({ run, receipt });

  const lease = await leaseStore.compareAndSetOwner({
    runId,
    expectedOwner: "chatgpt_direct",
    nextOwner: "handoff_to_codex",
  });

  const checkpoint = await checkpointStore.createCheckpoint({
    run_id: runId,
    trigger_source: "chatgpt_handoff",
    evidence_snapshot: receipt,
  });

  const session = await sessionResumeOrStart.resolve({
    run,
    nativeSessionId: run.native_session_id,
    worktreePath: run.workspace_ref.worktree_path,
    handoffInstruction: renderHandoffInstruction(receipt),
  });

  run = await runStore.compareAndSetState({
    runId,
    expectedState: "chatgpt_direct",
    nextState: "running",
    patch: {
      active_checkpoint_id: checkpoint.id,
      supervision: {
        ...run.supervision,
        controller_owner: "codex_active",
        controller_epoch: lease.epoch + 1,
        awaiting_progress_after_correction: false,
        last_handoff_receipt_id: receipt.id,
      },
    },
  });

  return { run, session };
}
```

## 9. 交还策略

优先级：

1. 原 native session 可恢复：resume 并发送 ChatGPT work receipt 摘要。
2. 原 session 不可恢复，但 Run 仍需要 Codex：同一 Run 创建新 Attempt，复用同一 worktree。
3. ChatGPT 已完成全部验收：不恢复 Builder，直接进入 canonical acceptance/evaluation。

不得：

- 创建新 Task 模拟交还。
- 将 ChatGPT 修改复制到另一个 worktree。
- 自动将未验证变更推入 canonical main。

## 10. Takeover 失败恢复

- quiescence timeout：保持 `codex_quiescing`，禁止 ChatGPT 写入，人工/下一轮 reconciler 处理。
- ChatGPT 工具调用失败：保持 `chatgpt_direct`，允许同 epoch 重试。
- lease 过期：进入 reconciliation，不能自动给 Codex。
- handoff verification 失败：保持 ChatGPT control 并返回具体缺失证据。
- native resume 失败：创建同 Run 新 Attempt 或等待，不回滚 ChatGPT 变更。

## 11. Phase 04 测试

- Codex 未静止时 ChatGPT patch 被拒绝。
- 两次稳定 snapshot 相同后才允许 takeover。
- controller epoch 过期的 Project Control 调用被拒绝。
- ChatGPT 只能访问 Run worktree。
- Receipt 缺 exit code 或 changed files 时不能 handoff。
- 原 native session 可恢复时复用。
- 不可恢复时同 Run 创建新 Attempt，不创建新 Task。
- ChatGPT 已完成全部验收时直接进入 evaluate。
- takeover/handoff 每一步重启后可恢复。
- 任意时刻最多一个写 owner。
