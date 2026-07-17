# ChatGPT Supervisor Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 ChatGPT 定时语义审查、同一 Codex TUI 幂等纠偏、native resume、ChatGPT takeover 与安全交还的持久闭环。

**Architecture:** WorkMCP 构建有 revision 的 ReviewPacket，ChatGPT 只输出结构化 Decision；所有副作用转换成 durable SupervisorCommand，由单一 Executor 在 controller lease 保护下执行。定时任务只负责触发 ChatGPT，不保存业务状态。

**Tech Stack:** Node.js ESM、现有 state store、ExecutionRun、Codex TUI PTY/session、node:test、WorkMCP tool groups。

## Global Constraints

- ExecutionRun 是唯一长期运行对象，不新增 SupervisorRun。
- correction/takeover/handoff 继续同一 Run 和同一 worktree。
- Canonical Acceptance 是最终完成事实源。
- ChatGPT 判断方向，规则只保护不变量。
- 所有写动作必须经过 durable command 与 controller lease。
- 禁止直接从定时任务调用 `codex_tui_send`。
- 每个任务先写失败测试，再实现最小代码。

---

## 文件结构

```text
backend/src/supervisor-review/
  supervisor-review-revision.mjs
  supervisor-review-packet-schema.mjs
  supervisor-review-packet-builder.mjs
  supervisor-review-request-store.mjs
  supervisor-decision-schema.mjs
  supervisor-decision-store.mjs
  supervisor-command-schema.mjs
  supervisor-command-store.mjs
  supervisor-controller-lease.mjs
  supervisor-action-guard.mjs
  supervisor-command-executor.mjs
  tui-correction-service.mjs
  correction-ack-reconciler.mjs
  codex-quiescence-service.mjs
  chatgpt-work-receipt-schema.mjs
  handoff-to-codex-service.mjs
  supervisor-review-service.mjs
  supervisor-review-worker.mjs

backend/src/codex-tui/
  native-session-resume-service.mjs
  session-binding-manifest.mjs

backend/src/tool-groups/supervisor-review/
  index.mjs
  supervisor-review-tools.mjs
  supervisor-decision-tools.mjs
  supervisor-command-tools.mjs
```

---

### Task 1：Review Revision 与 Packet Schema

**Files:**
- Create: `backend/src/supervisor-review/supervisor-review-revision.mjs`
- Create: `backend/src/supervisor-review/supervisor-review-packet-schema.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-revision.test.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-packet-schema.test.mjs`

**Interfaces:**
- Produces: `buildReviewRevision(input) -> ReviewRevision`
- Produces: `createSupervisorReviewPacket(input) -> SupervisorReviewPacket`

- [ ] **Step 1: 写 revision 失败测试**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewRevision } from "../../src/supervisor-review/supervisor-review-revision.mjs";

const facts = {
  run: { id: "run_1", version: 3, acceptance_contract_digest: "acc" },
  checkpoint: { id: "cp_1", digest: "cpd" },
  repository: { base_sha: "a", head_sha: "b", diff_digest: "d1", dirty_paths: ["b.mjs", "a.mjs"] },
  contextManifest: { digest: "ctx" },
  supervisorPlan: { version: 2 },
};

test("review revision is deterministic", () => {
  assert.deepEqual(buildReviewRevision(facts), buildReviewRevision(facts));
});

test("diff change invalidates revision", () => {
  const a = buildReviewRevision(facts);
  const b = buildReviewRevision({ ...facts, repository: { ...facts.repository, diff_digest: "d2" } });
  assert.notEqual(a.id, b.id);
});
```

- [ ] **Step 2: 运行并确认失败**

```bash
node --test backend/test/supervisor-review/supervisor-review-revision.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 revision**

使用 Phase 01 的 `buildReviewRevision` 伪代码；JSON 字段顺序固定，`dirty_paths` 排序。

- [ ] **Step 4: 写 Packet schema 测试**

必须覆盖缺少 `run.id`、缺少 revision、默认 allowed actions、secret 字段不被透传。

- [ ] **Step 5: 运行测试**

```bash
node --test backend/test/supervisor-review/supervisor-review-revision.test.mjs backend/test/supervisor-review/supervisor-review-packet-schema.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add backend/src/supervisor-review/supervisor-review-revision.mjs backend/src/supervisor-review/supervisor-review-packet-schema.mjs backend/test/supervisor-review/
git commit -m "feat(supervisor): add review revision and packet contracts"
```

---

### Task 2：Decision 与 Command Schema

**Files:**
- Create: `backend/src/supervisor-review/supervisor-decision-schema.mjs`
- Create: `backend/src/supervisor-review/supervisor-command-schema.mjs`
- Test: `backend/test/supervisor-review/supervisor-decision-schema.test.mjs`
- Test: `backend/test/supervisor-review/supervisor-command-schema.test.mjs`

**Interfaces:**
- Produces: `normalizeSupervisorDecision(input)`
- Produces: `commandFromDecision(decision, run)`

- [ ] 写失败测试：非法 action、send_correction 缺 objective、takeover 缺 reason 均拒绝。
- [ ] 运行：

```bash
node --test backend/test/supervisor-review/supervisor-decision-schema.test.mjs
```

Expected: FAIL。

- [ ] 按 Phase 01/02 实现 schema。
- [ ] 写 command idempotency 测试：相同 run/revision/action 得到相同 `idempotency_key`。
- [ ] 运行两个测试文件，Expected: PASS。
- [ ] 提交：

```bash
git add backend/src/supervisor-review/supervisor-decision-schema.mjs backend/src/supervisor-review/supervisor-command-schema.mjs backend/test/supervisor-review/
git commit -m "feat(supervisor): add decision and command contracts"
```

---

### Task 3：Review Request 与 Decision Store

**Files:**
- Create: `backend/src/supervisor-review/supervisor-review-request-store.mjs`
- Create: `backend/src/supervisor-review/supervisor-decision-store.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-request-store.test.mjs`
- Test: `backend/test/supervisor-review/supervisor-decision-store.test.mjs`

**Interfaces:**
- Consumes: `ReviewRevision`, `SupervisorDecision`
- Produces: `getOrCreate({runId, packet})`, `claim()`, `recordDecision()`

- [ ] 测试同一 `(run_id, revision_id)` 去重。
- [ ] 测试过期 claim 回收。
- [ ] 测试当前 revision 改变时 `recordDecision` 抛 `StaleReviewDecisionError`。
- [ ] 使用现有 stateStore transaction 模式实现，禁止独立 Map。
- [ ] 运行测试，Expected: PASS。
- [ ] 提交。

---

### Task 4：Command Store 与 Claim 幂等

**Files:**
- Create: `backend/src/supervisor-review/supervisor-command-store.mjs`
- Test: `backend/test/supervisor-review/supervisor-command-store.test.mjs`

**Interfaces:**
- Produces: `createFromDecision`, `claimNext`, `markApplying`, `markApplied`, `markRetryableFailure`, `markSuperseded`, `reclaimExpired`

- [ ] 写两个 worker 并发 claim 测试，断言仅一个成功。
- [ ] 写 applied command 重启后不可再次 claim 的测试。
- [ ] 写相同 idempotency key 去重测试。
- [ ] 实现事务式 claim。
- [ ] 运行：

```bash
node --test backend/test/supervisor-review/supervisor-command-store.test.mjs
```

Expected: PASS。
- [ ] 提交。

---

### Task 5：Controller Lease 与 Action Guard

**Files:**
- Create: `backend/src/supervisor-review/supervisor-controller-lease.mjs`
- Create: `backend/src/supervisor-review/supervisor-action-guard.mjs`
- Modify: `backend/src/supervisor/supervisor-policy-engine.mjs`
- Test: `backend/test/supervisor-review/supervisor-controller-lease.test.mjs`
- Test: `backend/test/supervisor-review/supervisor-action-guard.test.mjs`

**Interfaces:**
- Produces: `compareAndSetOwner({runId, expectedOwner, expectedEpoch, nextOwner})`
- Produces: `validateCommand({command, run, lease, currentRevision, plan})`

- [ ] 测试非法 `codex_active -> chatgpt_direct` 转换失败。
- [ ] 测试 epoch 不匹配失败。
- [ ] 测试 stale revision command 失败。
- [ ] 将现有 policy engine 的预算逻辑复用到 guard；删除方向判断职责。
- [ ] 运行测试并提交。

---

### Task 6：Review Packet Builder

**Files:**
- Create: `backend/src/supervisor-review/supervisor-review-packet-builder.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-packet-builder.test.mjs`

**Interfaces:**
- Consumes: run/checkpoint/plan/repository/TUI/history readers
- Produces: `build({runId}) -> SupervisorReviewPacket`

- [ ] 写 bounded packet 测试。
- [ ] 写 architecture baseline 优先级测试。
- [ ] 写 `focused_diff/new_symbols/tests/TUI progress` 聚合测试。
- [ ] 实现并行读取，但任何 optional 读取失败必须进入 `evidence_gaps`，不得 `catch {}` 静默忽略。
- [ ] 运行测试并提交。

---

### Task 7：重构 Checkpoint Supervisor Loop 为 Review Coordinator

**Files:**
- Modify: `backend/src/execution-core/checkpoint-supervisor-loop.mjs`
- Modify: `backend/src/dynamic-acceptance/checkpoint-acceptance-service.mjs`
- Test: `backend/test/execution-core/checkpoint-supervisor-loop.test.mjs`

**Interfaces:**
- Consumes: `packetBuilder.build`, `requestStore.getOrCreate`
- Produces: `tick(runId) -> {review_required, request, skipped_reason}`

- [ ] 写“一次 tick 只创建一个 checkpoint/review request”的失败测试。
- [ ] 写“相同 revision 再 tick 不重复”的测试。
- [ ] 删除 loop 中重复 acceptance orchestration。
- [ ] 将旧 acceptance service 保留为 deterministic evidence facade，不再决定架构方向。
- [ ] 运行现有 supervisor/dynamic-acceptance 回归测试并提交。

---

### Task 8：高层 Review/Decision 工具

**Files:**
- Create: `backend/src/tool-groups/supervisor-review/index.mjs`
- Create: `backend/src/tool-groups/supervisor-review/supervisor-review-tools.mjs`
- Create: `backend/src/tool-groups/supervisor-review/supervisor-decision-tools.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-tools.test.mjs`

**Interfaces:**
- Produces tools: `supervisor_review_active_runs`, `supervisor_submit_decisions`

- [ ] 测试 review 工具不调用 TUI sender。
- [ ] 测试 submit continue 决策不创建 command。
- [ ] 测试 submit correction 创建一个 command。
- [ ] 测试批量提交部分失败隔离。
- [ ] 注册到工具 catalog，保持 delayed discovery 兼容。
- [ ] 运行测试并提交。

---

### Task 9：Active TUI Structured Correction

**Files:**
- Create: `backend/src/supervisor-review/tui-correction-service.mjs`
- Create: `backend/src/supervisor-review/correction-ack-reconciler.mjs`
- Modify: `backend/src/dynamic-acceptance/checkpoint-correction-builder.mjs`
- Test: `backend/test/supervisor-review/tui-correction-service.test.mjs`

**Interfaces:**
- Consumes: command, run, session resolver, structured delta sender
- Produces: `apply(command, run)`

- [ ] 测试 active session 只发送一次 delta。
- [ ] 测试 session/worktree/run binding 不符时拒绝。
- [ ] 测试 correction 后设置 awaiting progress。
- [ ] 测试 ack 或 diff/progress 变化解除等待。
- [ ] Renderer 只渲染 ChatGPT Decision，不自行推断 missing items。
- [ ] 运行测试并提交。

---

### Task 10：Native Session Resume

**Files:**
- Create: `backend/src/codex-tui/session-binding-manifest.mjs`
- Create: `backend/src/codex-tui/native-session-resume-service.mjs`
- Modify: `backend/src/execution/providers/codex-tui-provider.mjs`
- Modify: `backend/src/execution/execution-provider-contract.mjs`
- Test: `backend/test/supervisor-review/native-session-resume-service.test.mjs`

**Interfaces:**
- Produces: `resume({run, nativeSessionId, worktreePath})`

- [ ] 先以只读方式验证本机 `codex resume` CLI 参数并记录 adapter 测试 fixture。
- [ ] 测试 control session 丢失时恢复 native session。
- [ ] 测试同 Run/Attempt/worktree 绑定。
- [ ] 测试 resume binding mismatch 为 terminal safety failure。
- [ ] 统一 provider `resume/sendDelta` 合同。
- [ ] 运行 provider 和 routing 回归测试并提交。

---

### Task 11：Command Executor 与 Worker

**Files:**
- Create: `backend/src/supervisor-review/supervisor-command-executor.mjs`
- Create: `backend/src/supervisor-review/supervisor-review-worker.mjs`
- Test: `backend/test/supervisor-review/supervisor-command-executor.test.mjs`
- Test: `backend/test/supervisor-review/supervisor-review-worker.test.mjs`

**Interfaces:**
- Consumes: command store, action guard, correction/takeover services
- Produces: `execute(command)`, `tick()`

- [ ] 测试 command applying 后重启 reconciliation。
- [ ] 测试 stale command 自动 supersede。
- [ ] 测试 retryable 与 terminal failure 分类。
- [ ] 实现 worker claim/reclaim/execute。
- [ ] 增加 runtime status 字段。
- [ ] 运行测试并提交。

---

### Task 12：Quiescence 与 ChatGPT Takeover

**Files:**
- Create: `backend/src/supervisor-review/codex-quiescence-service.mjs`
- Create: `backend/src/supervisor-review/chatgpt-work-receipt-schema.mjs`
- Modify: `backend/src/supervisor/supervisor-takeover-service.mjs`
- Modify: `backend/src/tool-groups/project-control/project-control-context.mjs`
- Modify: Project Control 写工具
- Test: `backend/test/supervisor-review/codex-quiescence-service.test.mjs`
- Test: `backend/test/supervisor-review/chatgpt-takeover.test.mjs`

**Interfaces:**
- Produces: `quiesce({run, command})`, `takeover({runId, command})`

- [ ] 测试 Codex 未静止时 Project Control 写入被拒绝。
- [ ] 测试两次稳定 snapshot 后 lease 转给 ChatGPT。
- [ ] 测试 controller epoch 保护所有 patch/command/test 写操作。
- [ ] 改造 takeover service，删除直接跳转状态。
- [ ] 运行 Project Control 与 Supervisor 测试并提交。

---

### Task 13：Handoff to Codex

**Files:**
- Create: `backend/src/supervisor-review/handoff-to-codex-service.mjs`
- Test: `backend/test/supervisor-review/handoff-to-codex-service.test.mjs`

**Interfaces:**
- Consumes: ChatGPTWorkReceipt, lease, native resume/new attempt service
- Produces: `handoff({runId, receipt})`

- [ ] 测试 Receipt 缺命令 exit code 时拒绝。
- [ ] 测试优先恢复原 native session。
- [ ] 测试不可恢复时同 Run 新 Attempt，不新建 Task。
- [ ] 测试 ChatGPT 已满足 acceptance 时直接 evaluate。
- [ ] 运行测试并提交。

---

### Task 14：故障注入与 E2E Canary

**Files:**
- Create: `backend/test/supervisor-review/supervisor-restart-recovery.test.mjs`
- Create: `backend/test/supervisor-review/supervisor-e2e-canary.test.mjs`
- Modify: runtime composition root and feature flags

- [ ] 注入 Decision 保存后崩溃。
- [ ] 注入 PTY send 成功但 markApplied 前崩溃。
- [ ] 注入 native resume 启动后 binding 写入失败。
- [ ] 注入 quiesce 后 checkpoint 写入失败。
- [ ] 运行 Phase 06 中 Canary A-E。
- [ ] 运行：

```bash
node --test backend/test/supervisor-review/*.test.mjs
node --test backend/test/supervisor/*.test.mjs
node --test backend/test/execution-core/*.test.mjs
node --test backend/test/tui-autopilot/*.test.mjs
node --test backend/test/codex-tui-provider-routing.test.mjs
node --test backend/test/task-provider-dispatcher.test.mjs
git diff --check
```

Expected: 全部 PASS。

- [ ] 运行仓库全量测试并记录真实 passed/failed 数量。
- [ ] 仅在全量回归通过后启用生产 feature flags。
- [ ] 提交：

```bash
git add backend/src backend/test docs/chatgpt-supervisor-refactor-2026-07-18
git commit -m "feat(supervisor): complete scheduled ChatGPT correction loop"
```

---

## 执行建议

- Task 1-2 可并行。
- Task 3-4 可并行，但都依赖 Task 1-2。
- Task 5-7 串行，先冻结状态语义再改 loop。
- Task 8 可与 Task 9 的纯工具/schema 部分并行。
- Task 10 之后再接真实 resume。
- Task 11 必须先于 Task 12-13 的生产启用。
- Task 14 是唯一允许打开生产 flags 的阶段。
