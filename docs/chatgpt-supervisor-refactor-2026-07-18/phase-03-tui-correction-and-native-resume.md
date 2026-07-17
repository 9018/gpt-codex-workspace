# Phase 03：同一 Codex TUI 纠偏与 Native Resume

## 1. 目标

实现以下优先级：

```text
active control session 可写
  -> 直接发送 structured correction
否则 native session 可恢复
  -> codex resume <native-session-id>
  -> 重新绑定 control session
  -> 发送同一 correction
否则
  -> command retryable_failed / 提升 takeover
```

不得创建新 Goal、Task 或 worktree。

## 2. TUI Correction Service

新增：`backend/src/supervisor-review/tui-correction-service.mjs`

```js
export function createTuiCorrectionService(deps) {
  async function apply(command, run) {
    const correction = deps.correctionRenderer.render(command.payload.decision);
    const session = await deps.sessionResolver.resolve(run);

    if (session.active && session.writable) {
      return sendToActive({ command, run, session, correction });
    }

    if (session.native_session_id && session.resumable) {
      const resumed = await deps.nativeResumeService.resume({
        run,
        nativeSessionId: session.native_session_id,
        worktreePath: run.workspace_ref.worktree_path,
      });
      return sendToActive({
        command,
        run,
        session: resumed,
        correction,
      });
    }

    throw new TuiSessionUnavailableError({
      runId: run.id,
      controlSessionId: session.session_id,
      nativeSessionId: session.native_session_id,
    });
  }

  async function sendToActive({ command, run, session, correction }) {
    await deps.sessionGuard.assertBoundToRun({ session, run });
    await deps.sessionGuard.assertSameWorktree({ session, run });

    const delta = {
      schema_version: 1,
      type: "architecture_correction",
      command_id: command.id,
      review_revision_id: command.review_revision_id,
      instruction: correction,
      expected_ack: {
        command_id: command.id,
        revision_id: command.review_revision_id,
      },
    };

    await deps.tuiDeltaSender.preview({ sessionId: session.id, delta });
    const sent = await deps.tuiDeltaSender.send({ sessionId: session.id, delta });

    await deps.runStore.updateRun(run.id, {
      supervision: {
        ...run.supervision,
        last_correction_id: command.id,
        last_correction_revision: command.review_revision_id,
        correction_cycles: (run.supervision?.correction_cycles || 0) + 1,
        awaiting_progress_after_correction: true,
      },
    });

    return {
      session_id: session.id,
      native_session_id: session.native_session_id,
      delta_id: sent.delta_id,
      sent_at: sent.sent_at,
    };
  }

  return { apply };
}
```

## 3. 为什么优先使用 structured task delta

当前已有 `codex_tui_preview_task_delta` 和 `codex_tui_send_task_delta`。纠偏不应默认使用裸 `codex_tui_send`，因为 structured delta 可以持久化：

- command id。
- review revision。
- 类型。
- 预期 acknowledgement。
- 同 Task 不变量。

裸文本 send 仅作为兼容 fallback，并必须记录 hash。

## 4. Session Binding Manifest

每个 TUI Attempt 必须保存：

```js
{
  run_id,
  attempt_id,
  task_id,
  goal_id,
  worktree_path,
  control_session_id,
  native_session_id,
  resume_token,
  codex_home,
  started_at,
  last_bound_at,
}
```

绑定验证：

```js
function assertSessionBinding({ binding, run }) {
  assert(binding.run_id === run.id);
  assert(realpath(binding.worktree_path) === realpath(run.workspace_ref.worktree_path));
  assert(binding.attempt_id === run.active_attempt_id);
}
```

## 5. Native Resume Service

新增或收敛到 `backend/src/codex-tui/native-session-resume-service.mjs`。

```js
export function createNativeSessionResumeService(deps) {
  async function resume({ run, nativeSessionId, worktreePath }) {
    await deps.processGuard.assertNoActiveControlSession(run.id);
    await deps.repositoryGuard.assertWorktreeExists(worktreePath);
    await deps.repositoryGuard.assertExpectedIdentity({ run, worktreePath });

    const control = await deps.ptyManager.spawn({
      cwd: worktreePath,
      env: { CODEX_HOME: run.codex_home },
      command: "codex",
      args: ["resume", nativeSessionId],
    });

    const binding = await deps.sessionBinder.bind({
      runId: run.id,
      attemptId: run.active_attempt_id,
      nativeSessionId,
      controlSessionId: control.id,
      worktreePath,
    });

    await deps.readyProbe.waitUntilWritable(control.id);
    return binding;
  }

  return { resume };
}
```

注意：真正命令参数应以当前 Codex CLI 实测为准，不能只依赖伪代码。实现任务必须运行 `codex resume --help` 或等价只读验证，并在测试中 mock CLI adapter。

## 6. Acknowledgement 与 Progress Gate

发送成功不等于 Codex 已接受。

需要至少两个证明：

1. delta 已持久化并写入 PTY。
2. 后续 progress 或 log 中出现 command acknowledgement，或出现新的代码/diff/progress revision。

新增：`correction-ack-reconciler.mjs`

```js
async function reconcile(command, run) {
  const observation = await observationService.observe(run);

  if (observation.ack_command_id === command.id) {
    return markAcknowledged(command, observation);
  }

  if (observation.diff_digest !== command.preconditions.diff_digest ||
      observation.progress_revision > command.preconditions.progress_revision) {
    return markImplicitlyAcknowledged(command, observation);
  }

  if (now() > command.ack_deadline) {
    throw new CorrectionNotAcknowledgedError(command.id);
  }

  return { status: "waiting" };
}
```

## 7. 防止重复轰炸

Run supervision 新增：

```js
{
  last_review_revision,
  last_correction_id,
  last_correction_revision,
  correction_cycles,
  awaiting_progress_after_correction,
  correction_sent_at,
  correction_acknowledged_at,
  last_progress_revision,
  native_resume_count,
}
```

规则：

```text
awaiting_progress_after_correction=true
且 review revision 未变化
=> 不创建新 correction command
```

若超时：

```text
先检查 session
 -> active 但无 ack：pause / takeover
 -> control 丢失且 native resumable：resume once
 -> 已 resume 仍无进展：takeover
```

## 8. 修改 Provider Contract

统一 provider 方法：

```js
{
  availability(),
  start(),
  resume(),
  observe(),
  sendDelta(),
  interrupt(),
  collect(),
  dispose(),
}
```

Provider 返回运行事实，不返回业务 verdict：

```js
{
  state: "running" | "evidence_ready" | "supervisor_required" | "failed",
  control_session_id,
  native_session_id,
  progress,
  failure,
}
```

## 9. 失败分类

```text
control_session_missing        -> try native resume
native_session_missing         -> takeover/wait
resume_process_failed          -> retryable once
resume_binding_mismatch        -> terminal safety failure
worktree_identity_mismatch     -> terminal safety failure
correction_send_failed         -> retryable
correction_not_acknowledged    -> pause then takeover
stale_review_revision          -> superseded, no send
```

## 10. Phase 03 测试

- active session 直接发送一次 delta。
- 重复执行同 command 不重复 send。
- control session 丢失时使用 native session resume。
- resume 后仍绑定同一 worktree、run、attempt。
- native session 与 Run 不匹配时拒绝。
- correction 发送后 Run 进入 awaiting progress。
- progress/diff 更新后解除 awaiting 状态。
- correction 未 ack 超时后不无限 resume。
- stale command 在发送前被 supersede。
- 不创建新 Task、Goal、worktree。
