# Phase 06：测试矩阵、Canary、迁移与分波实施

## 1. 总体策略

本重构不能一次性替换当前 Supervisor 和 Dynamic Acceptance。采用 strangler migration：

```text
旧 checkpoint loop
 -> 新 ReviewRequest shadow mode
 -> ChatGPT Decision dry-run
 -> Command shadow mode
 -> 单 Run allowlist 执行 correction
 -> native resume canary
 -> takeover canary
 -> 定时任务生产启用
 -> 删除重复旧路径
```

## 2. Wave 拆分

### Wave 0：Schema 与纯函数

新增：

```text
supervisor-review-revision.mjs
supervisor-review-packet-schema.mjs
supervisor-decision-schema.mjs
supervisor-command-schema.mjs
```

只做纯数据，不接生产入口。

验收：

- schema tests 全过。
- revision deterministic。
- 无现有行为变化。

### Wave 1：Review Packet Builder 与 Store

新增：

```text
supervisor-review-packet-builder.mjs
supervisor-review-request-store.mjs
supervisor-decision-store.mjs
```

接入 shadow mode：每次 checkpoint 额外生成 packet，但不调用 ChatGPT、不执行动作。

验收：

- packet bounded。
- 同 revision 去重。
- 不产生 TUI 写入。

### Wave 2：高层工具与 ChatGPT dry-run

新增：

```text
tool-groups/supervisor-review/*
```

定时任务可以读取 packet 和提交 Decision，但 `apply=false`。

验收：

- Decision 可审计。
- 旧 revision 拒绝。
- action 不执行。

### Wave 3：Durable Command 与 Active TUI Correction

新增：

```text
supervisor-command-store.mjs
supervisor-command-executor.mjs
tui-correction-service.mjs
correction-ack-reconciler.mjs
```

仅 allowlist Run 执行 `send_correction`，不启用 resume/takeover。

验收：

- 一次 send。
- ack/progress gate。
- 重启不重复。

### Wave 4：Native Resume

新增：

```text
native-session-resume-service.mjs
session-binding-manifest.mjs
```

验收：

- control session 丢失可恢复。
- 同 Run/Attempt/worktree。
- resume 失败有结构化分类。

### Wave 5：Controller Lease 与 ChatGPT Takeover

新增：

```text
supervisor-controller-lease.mjs
codex-quiescence-service.mjs
handoff-to-codex-service.mjs
chatgpt-work-receipt-schema.mjs
```

改造：

```text
supervisor-takeover-service.mjs
project-control-context.mjs
project-control write tools
```

验收：任意时刻只有一个 writer。

### Wave 6：生产定时任务与事件触发

- 开启 supervisor-review worker。
- 配置 ChatGPT 定时任务。
- 事件触发创建 request，定时任务兜底。
- 建立 dashboard 和 alert。

### Wave 7：删除重复路径

删除或降级：

- `checkpoint-supervisor-loop` 内的重复 checkpoint 创建。
- `checkpoint-acceptance-service` 内的 trigger/collect/create 流程。
- 基于 trigger type 直接决定方向动作的逻辑。
- 任意绕过 command store 的直接 TUI send。

## 3. 单元测试目录

```text
backend/test/supervisor-review/
  supervisor-review-revision.test.mjs
  supervisor-review-packet-schema.test.mjs
  supervisor-review-packet-builder.test.mjs
  supervisor-review-request-store.test.mjs
  supervisor-decision-schema.test.mjs
  supervisor-decision-store.test.mjs
  supervisor-command-store.test.mjs
  supervisor-command-executor.test.mjs
  supervisor-controller-lease.test.mjs
  tui-correction-service.test.mjs
  native-session-resume-service.test.mjs
  codex-quiescence-service.test.mjs
  handoff-to-codex-service.test.mjs
  supervisor-review-tools.test.mjs
  supervisor-review-worker.test.mjs
```

## 4. 必测不变量

### 4.1 Revision 幂等

```js
test("same facts produce the same review revision", () => {
  assert.equal(buildReviewRevision(facts).id, buildReviewRevision(facts).id);
});

test("diff change invalidates previous revision", () => {
  assert.notEqual(
    buildReviewRevision({ ...facts, repository: { diff_digest: "a" } }).id,
    buildReviewRevision({ ...facts, repository: { diff_digest: "b" } }).id,
  );
});
```

### 4.2 不重复纠偏

```js
test("repeated scheduled checks do not resend the same correction", async () => {
  const decision = await submitDecision(sendCorrectionDecision);
  await worker.tick();
  await worker.tick();

  assert.equal(tuiDeltaSender.send.mock.calls.length, 1);
  assert.equal((await commandStore.readByDecision(decision.id)).status, "applied");
});
```

### 4.3 Stale Decision

```js
test("stale decision cannot create a command", async () => {
  await repositoryEvidence.setDiffDigest("new-digest");

  await assert.rejects(
    () => decisionService.submit(oldRevisionDecision),
    StaleReviewDecisionError,
  );

  assert.equal(await commandStore.count(), 0);
});
```

### 4.4 单写者

```js
test("chatgpt patch is blocked until codex is quiescent", async () => {
  leaseStore.set({ owner: "codex_active", epoch: 4 });

  await assert.rejects(
    () => projectPatchTool({ run_id: run.id, controller_epoch: 4, patch }),
    ProjectControlInvariantError,
  );
});
```

### 4.5 Resume 同一现场

```js
test("native resume preserves run attempt and worktree binding", async () => {
  const resumed = await nativeResumeService.resume({
    run,
    nativeSessionId: "native-1",
    worktreePath: run.workspace_ref.worktree_path,
  });

  assert.equal(resumed.run_id, run.id);
  assert.equal(resumed.attempt_id, run.active_attempt_id);
  assert.equal(resumed.worktree_path, run.workspace_ref.worktree_path);
});
```

### 4.6 Takeover 交还

```js
test("handoff uses the same run and worktree", async () => {
  const result = await handoffService.handoff({ runId: run.id, receipt });

  assert.equal(result.run.id, run.id);
  assert.equal(result.session.worktree_path, run.workspace_ref.worktree_path);
  assert.equal(taskFactory.create.mock.calls.length, 0);
});
```

## 5. 故障注入测试

必须在 store、TUI send、resume、lease transition 的每个关键边界注入故障：

- Decision 已保存，Command 创建前崩溃。
- Command applying 后、PTY send 前崩溃。
- PTY send 成功、markApplied 前崩溃。
- correction 已发送但 ack 未记录时重启。
- native resume 进程启动后绑定写入失败。
- quiesce interrupt 成功但 snapshot 未保存。
- ChatGPT patch 完成但 Receipt 未写。
- handoff session 恢复后 Run transition 失败。

每个故障都必须有明确 reconciliation 规则。

## 6. E2E Canary

### Canary A：方向正确

- Codex 正常修改。
- ChatGPT Decision=`continue_codex`。
- 无 command、无 TUI 输入。

### Canary B：轻微方向偏离

- Codex 新增不必要的第二套 adapter。
- ChatGPT 输出 `send_correction`。
- 同一 TUI 收到 correction。
- Codex 删除旁路并继续。

### Canary C：控制 session 丢失

- 保留 native session。
- 定时审查发现偏离。
- WorkMCP resume 同 native session。
- correction 发送并产生新 progress。

### Canary D：重复无收敛

- 两次 correction 后仍重复同一错误。
- ChatGPT Decision=`chatgpt_takeover`。
- Codex quiesce。
- ChatGPT 在同一 worktree 修改并测试。
- 交还 Codex 或直接 acceptance。

### Canary E：服务重启

在每个 command phase 重启服务，验证：

- request/decision/command 不丢。
- applied command 不重复。
- applying command 可对账。
- controller owner 不产生双写。

## 7. 回归测试

每个 Wave 至少运行：

```bash
node --test backend/test/supervisor-review/*.test.mjs
node --test backend/test/supervisor/*.test.mjs
node --test backend/test/execution-core/*.test.mjs
node --test backend/test/tui-autopilot/*.test.mjs
node --test backend/test/codex-tui-provider-routing.test.mjs
node --test backend/test/task-provider-dispatcher.test.mjs
git diff --check
```

关键 Wave 完成后运行仓库全量测试。不得只依据测试名称或 Codex 自述填写结果。

## 8. Feature Flags

```text
GPTWORK_SUPERVISOR_REVIEW_ENABLED=false
GPTWORK_SUPERVISOR_REVIEW_SHADOW=true
GPTWORK_SUPERVISOR_COMMANDS_ENABLED=false
GPTWORK_SUPERVISOR_TUI_CORRECTION_ENABLED=false
GPTWORK_SUPERVISOR_NATIVE_RESUME_ENABLED=false
GPTWORK_CHATGPT_TAKEOVER_ENABLED=false
```

启用顺序必须与 Wave 一致。

## 9. 生产指标

- review requests / run / hour。
- unchanged revision skip ratio。
- Decision action distribution。
- correction acknowledgement rate。
- correction 后收敛率。
- native resume 成功率。
- takeover 率与成功率。
- duplicate command prevention count。
- stale decision rejection count。
- controller lease conflict count。
- average time from drift to correction。
- average time from correction to new progress。

## 10. 最终删除条件

只有满足以下条件才删除旧路径：

- 新 review runtime 连续通过 Canary。
- 所有 TUI correction 都通过 command store。
- 没有调用方依赖旧 acceptance service 返回 trigger-based action。
- restart tests 证明 command 不重放。
- takeover 单写者不变量通过故障注入。
- 全量回归通过。

## 11. 代码审查清单

每个 Wave 的 Reviewer 必须回答：

- 是否又新增了第二套 Run/Review/Command 状态？
- 是否有直接调用 `codex_tui_send` 绕过 command executor？
- 是否有 `catch {}` 吞掉状态写失败？
- 是否把 ChatGPT Decision 当自然语言而非 schema？
- 是否把定时任务当持久状态机？
- 是否允许 Codex/ChatGPT 同时写 worktree？
- 是否创建了新 Task 来模拟 correction/takeover/handoff？
- 是否仍然保持 Canonical Acceptance 为最终完成事实源？
