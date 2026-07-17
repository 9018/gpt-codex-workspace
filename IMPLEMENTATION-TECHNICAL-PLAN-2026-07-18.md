# Execution OS 与原生 Codex TUI Supervisor 实施技术方案

> 文档状态：实施基线  
> 代码基准：`main@1d818da`，包含当前未提交的 `execution-core` 改动  
> 最后更新：2026-07-18  
> 产品主线：ChatGPT 高级监督 + WorkMCP 持久无人监管 + 原生 Codex TUI 执行 + 同 worktree 动态接管

## 1. 文档用途

本文档是后续 Wave 拆分、Codex 任务下发、代码评审、验收、集成和回滚的统一技术基线。任何改变顶层状态模型、默认 Provider、终态验收链、幂等规则或 worktree 所有权的改动，必须先更新本文档。

## 2. 当前代码基线

当前仓库已经开始实施 Execution OS：

- 新增 `backend/src/execution-core/`；
- 新增 `backend/test/execution-core/`；
- 修改 Provider Contract、Provider Registry、Codex Exec/TUI Provider；
- 修改 `backend/src/executions/execution-contract.mjs`；
- 定向测试 242/242 通过；
- 真实“默认 Codex TUI 全流程” Canary 仍失败，缺少 result、verification 与 contract verification Evidence。

当前测试通过只证明数据骨架和 mock 行为可运行，不代表原生 TUI 产品闭环已完成。

## 3. 核心架构决议

1. `ExecutionRun` 是唯一持久业务运行状态，不新增独立 `SupervisorRun`。
2. `SupervisorPlan`、Checkpoint、控制权、纠偏历史和接管状态全部挂接 `ExecutionRun`。
3. 原生 `codex_tui` 是默认 Provider；`codex_exec` 仅作为显式兼容路径，不自动 fallback。
4. Provider 只能启动、恢复、观察、停止和收集原始 Evidence，不能决定 Run、Task 或 Goal 完成。
5. Run 完成必须经过 Evidence、AcceptanceDecision、Canonical Decision 和 Progression。
6. ChatGPT 接管必须操作当前 Run 绑定的同一 worktree、分支和 Git 状态，不创建 repair task 或新 worktree。
7. Run、Event、Attempt、Checkpoint、Pending Effect 和终态副作用必须持久化、幂等且可重放。
8. 屏幕文本与 Codex 自述只能作为 Provider Claim，不能替代 Git、命令、测试与结构化验收事实。

## 4. 目标架构

```text
User Request
  -> ExecutionIntent
  -> ExecutionPlan
  -> ExecutionRun
       |- ExecutionAttempt[]
       |- SupervisorPlan
       |- SupervisorCheckpoint[]
       |- controller_owner
       |- EvidenceBundle
       |- AcceptanceDecision
       |- Delivery / Integration
       `- Task / Goal / Workstream Projection
  -> Native Codex TUI
  -> Dynamic Checkpoint Acceptance
  -> Correction / Native Resume / ChatGPT Takeover
  -> Canonical Terminal Decision
  -> Progression Effects
```

控制权枚举：

```javascript
export const CONTROLLER_OWNERS = Object.freeze([
  "workmcp_autopilot",
  "chatgpt_supervising",
  "chatgpt_direct",
  "waiting_for_chatgpt",
]);
```

## 5. 当前 P0 问题

### 5.1 Evidence 后无条件完成

文件：`backend/src/execution-core/execution-run-service.mjs`

当前 `advanceRun()` 在 `evidence_ready` 后直接从 `evaluating` 进入 `completed`。必须改为真实调用 Acceptance：

```javascript
run = await transition(run, "collecting", "evaluating");

const decision = await acceptanceService.evaluate({
  run,
  intent,
  plan,
  evidence,
});

run = await runStore.updateRun(run.id, {
  acceptance_decision_id: decision.id,
});

switch (decision.status) {
  case "accepted":
    return deliverOrComplete(run, decision);
  case "repair_required":
    return transitionWithCheckpoint(run, "waiting_for_repair", decision);
  case "review_required":
    return transitionWithCheckpoint(run, "waiting_for_review", decision);
  case "supervisor_required":
    return transitionWithCheckpoint(run, "waiting_for_supervisor", decision);
  default:
    return failRun(run, decision.failure);
}
```

禁止任何 `evidence_ready -> completed` 直通路径。

### 5.2 Supervisor 与 Repair 混淆

新增 Run 状态：

```javascript
"checkpointing",
"correcting",
"resuming",
"waiting_for_supervisor",
"chatgpt_direct",
```

语义：

- `waiting_for_repair`：修复动作明确，可无人监管继续；
- `waiting_for_supervisor`：需要 ChatGPT 高级判断；
- `chatgpt_direct`：ChatGPT 已接管同一 worktree。

### 5.3 Run/Event Store 仅为内存 Map

`execution-run-store.mjs` 与 `execution-event-store.mjs` 必须改为复用现有 `state-store.mjs` transaction，至少持久化：

```javascript
state.execution_runs = {};
state.execution_events = {};
state.execution_request_index = {};
state.execution_event_index = {};
state.supervisor_plans = {};
state.supervisor_checkpoints = {};
```

CAS 必须同时检查 `version` 与 `state`，并记录 `idempotency_key`。

### 5.4 重复 start 幂等合同错误

同一 `request_id` 或 `idempotency_key` 重复调用必须返回同一个 Run。只有显式 `force_new_run: true` 才能建立新 Run。

### 5.5 默认 Provider 策略错误

统一默认：

```javascript
execution_policy: {
  preferred_provider: "codex_tui",
  fallback_allowed: false,
  fallback_order: [],
  interaction_mode: "automatic",
  max_attempts: 3,
}
```

TUI 不可用时进入恢复或 `waiting_for_supervisor`，不得自动切 Exec。显式指定 Exec 时继续兼容。

### 5.6 TUI resume 逻辑错误

Provider 不应在活跃 session 中盲发 `/resume`。恢复优先级：

```text
活跃 tmux pane 可恢复 -> restore pane
已知 native session ID -> codex resume <id> <continuation>
以上失败 -> checkpointed TUI attempt
仍失败 -> waiting_for_supervisor
```

### 5.7 Provider normalize 未形成强制边界

Provider Registry 必须包装所有 Provider：

```javascript
start   -> normalizeProviderSession
resume  -> normalizeProviderSession
observe -> normalizeProviderObservation
collect -> normalizeRawEvidence
```

未知 observation 状态必须 fail closed，不能默认映射为 `running`。

### 5.8 Projection 错误被静默吞掉

Projection 失败必须写 Event，并创建 durable pending effect：

```javascript
{
  action: "reconcile_projection",
  run_id: run.id,
  run_version: run.version,
  idempotency_key: `projection:${run.id}:${run.version}`,
}
```

不得再次出现 Run completed、Task running、Goal assigned 的状态分叉。

## 6. ExecutionRun 扩展

修改：`backend/src/execution-core/execution-run-schema.mjs`

```javascript
export function createExecutionRun(input) {
  return {
    schema_version: 1,
    id: input.id || createId("run"),
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    intent_id: input.intent_id,
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    workstream_id: input.workstream_id || null,
    plan_id: input.plan_id || null,
    supervisor_plan_id: input.supervisor_plan_id || null,
    acceptance_contract_id: input.acceptance_contract_id || null,
    state: "created",
    outcome: null,
    active_attempt_id: null,
    attempt_ids: [],
    workspace_ref: null,
    path_context_ref: null,
    context_ref: null,
    active_checkpoint_id: null,
    checkpoint_ids: [],
    evidence_bundle_id: null,
    acceptance_decision_id: null,
    delivery_id: null,
    supervision: {
      controller_owner: "workmcp_autopilot",
      execution_mode: "native_tui",
      correction_cycles: 0,
      same_failure_retries: 0,
      native_resume_count: 0,
      chatgpt_takeover_count: 0,
      last_failure_signature: null,
      waiting_reason: null,
      takeover_reason: null,
      last_instruction_digest: null,
    },
    failure: null,
    pending_effects: [],
    applied_mutation_keys: [],
    version: 1,
    created_at: now(),
    updated_at: now(),
  };
}
```

## 7. Supervisor 数据层

新增：

```text
backend/src/supervisor/
|- supervisor-plan-schema.mjs
|- supervisor-plan-store.mjs
|- supervisor-checkpoint-schema.mjs
|- supervisor-checkpoint-store.mjs
|- supervisor-policy-engine.mjs
|- supervisor-context-packet.mjs
|- supervisor-takeover-service.mjs
`- supervisor-errors.mjs
```

禁止新增 `supervisor-run-schema.mjs` 和 `supervisor-run-store.mjs`。

SupervisorPlan 至少包含：用户目标、架构决议、执行步骤、验收合同、TUI 策略、自治预算、Checkpoint 策略和接管策略。

## 8. TUI Session Manager 拆分

当前 `backend/src/codex-tui-session-manager.mjs` 约 55 KB。新增 Supervisor 前先拆成：

```text
backend/src/codex-tui/
|- index.mjs
|- active-session-registry.mjs
|- session-service.mjs
|- session-bootstrap.mjs
|- session-recovery.mjs
|- session-terminalizer.mjs
|- session-process-cleanup.mjs
|- session-input-service.mjs
|- native-session-binding.mjs
`- acceptance-repair-adapter.mjs
```

旧文件保留为兼容 facade，目标小于 150 行；`session-service.mjs` 目标小于 300 行。

## 9. 原生 `/goal` Driver

新增：

```text
backend/src/tui-autopilot/
|- tui-keyboard-driver.mjs
|- tui-slash-command-driver.mjs
|- tui-goal-command-driver.mjs
`- tui-action-schema.mjs
```

流程：等待 `ready_for_input` -> 输入 `/goal` -> Enter -> 等待 `goal_input` -> 输入目标 -> Enter -> 等待工作状态。

幂等键：`goal-bootstrap:<run-id>:<plan-revision>`。

Fallback 顺序：真实 `/goal` -> argv prompt -> plain prompt。同一 plan revision 禁止重复提交。

## 10. 动态 Checkpoint Acceptance

新增：

```text
backend/src/dynamic-acceptance/
|- checkpoint-trigger-policy.mjs
|- checkpoint-evidence-collector.mjs
|- checkpoint-acceptance-service.mjs
|- checkpoint-verdict-schema.mjs
|- checkpoint-correction-builder.mjs
`- checkpoint-history-store.mjs
```

触发条件：TUI idle、Git diff 改变、测试结束、no-progress、定时间隔。

动作：`continue_codex`、`send_correction`、`run_deterministic_repair`、`resume_native_session`、`chatgpt_takeover`、`wait_for_chatgpt`、`evaluate_terminal`。

Checkpoint Verdict 只决定下一动作，不直接写 `completed`。

## 11. ChatGPT 同 worktree 接管

新增：

```text
backend/src/tool-groups/project-control/
|- index.mjs
|- project-control-context.mjs
|- project-read-tools.mjs
|- project-search-tools.mjs
|- project-diff-tools.mjs
|- project-patch-tools.mjs
|- project-command-tools.mjs
|- project-test-tools.mjs
|- project-takeover-tools.mjs
`- project-control-audit.mjs
```

强制不变量：controller owner 为 `chatgpt_direct`、Run worktree 等于 PathContext worktree、分支一致、Run version 匹配、目标文件属于同一 worktree。

禁止创建 repair task、新 worktree、切 branch 或默认 reset Codex 改动。

## 12. Canonical Decision 与 Progression

新增：

```text
backend/src/execution-core/canonical-acceptance-adapter.mjs
backend/src/execution-core/progression-effect-adapter.mjs
```

终态链：Terminal Evidence -> Existing Acceptance/Closure/Unified Decision -> Progression Command -> Task/Goal/Queue/Integration Effects。

Run 进入 `completed` 必须满足 canonical completed、consistency checker 通过、integration requirement 已满足、terminal effects 已应用或持久化为 pending effect。

## 13. 实施 Wave

### Wave 0R：纠正当前未提交 Execution Core

修正 Run 完成语义、状态机、幂等 start、durable Store、默认 TUI、Projection pending effect 和错误测试合同。

### Wave 1R：Provider 边界硬化

强制 normalize、未知状态 fail closed、native resume、Provider 不输出业务终态、Exec 仅显式兼容。

### Wave 2R：拆 TUI Session Manager

只做行为保持型重构，旧 API 全兼容。

### Wave 3R：Supervisor Plan/Checkpoint

挂接 ExecutionRun，不新增 SupervisorRun。

### Wave 4R：真实 `/goal` + native resume

实现真实两阶段 `/goal`、bootstrap 幂等、native UUID 和服务重启恢复。

### Wave 5R：ExecutionRun 接管 TUI Attempt

首次启动、native resume、tmux restore、checkpoint retry 都记录为 Attempt。

### Wave 6R：动态 Checkpoint Acceptance

实现自动纠偏、重复失败接管和高不确定性暂停。

### Wave 7R：Project Control 接管工具

ChatGPT 在同一 worktree patch/test/audit，并可交还同一 TUI session。

### Wave 8R：Canonical Terminal Integration

接回现有 canonical decision 与 progression command。

### Wave 9R：真实 Canary

覆盖 `/goal`、修改代码、动态纠偏、测试 Evidence、native resume、服务重启、ChatGPT takeover、同 worktree patch、交还 Codex、canonical completion 和状态投影。

### Wave 10R：后续通用化

主闭环稳定后再迁移 question/test/docs、多 Agent DAG、可配置 Exec/TUI 和删除旧 execution 路径。

## 14. 第一批任务拆分

### Task 1：Run 完成语义

修改 Run Service、Run Schema、State Machine 和对应测试。验收：Evidence 未验收不能 completed；supervisor_required 进入 waiting_for_supervisor；accepted 才可进入 terminal。

### Task 2：幂等与 Durable Store

修改 Run Store、Event Store、State Store 和对应测试。验收：同 request_id 返回同 Run；服务重建后可读取；CAS 检查 version/state；Event append 幂等。

### Task 3：默认 TUI 策略

修改 Intent Schema、Legacy Adapter、Execution Contract 和相关测试。验收：默认 codex_tui；默认 fallback=false；TUI unavailable 不自动 Exec；显式 Exec 兼容。

### Task 4：Provider normalize

修改 Provider Contract、Registry、Codex TUI Provider 和对应测试。验收：start/resume/observe/collect 全部 normalize；未知状态报错；native resume 不盲发 `/resume`。

Task 1、2、3 可并行；Task 4 在 Task 3 合并后接入。

## 15. 必须改写的错误测试合同

```text
duplicate start creates independent runs
unavailable TUI automatically falls back to exec
evidence_ready automatically completes
unknown provider observation defaults to running
supervisor_required maps to waiting_for_repair
```

新增不变量：无 AcceptanceDecision 不得 completed；失败 Attempt 不得投影 Task running；同 request ID 不得创建多个 Run；未知 observation 不得变成 running；ChatGPT direct 的 worktree 必须等于 Run worktree。

## 16. Release Gate

发布前必须通过 Execution Core、Provider Contract、TUI restart、Dynamic Checkpoint、Project Control、Canonical/Progression 重放、真实原生 TUI Canary、重复调用幂等、服务重启恢复和 Task/Goal/Queue 一致性测试。

## 17. 回滚要求

每个 Wave 独立提交、独立测试、可单独回滚。禁止一次性删除旧 API。新增核心路径通过兼容 adapter 接入，直到真实 Canary 和一致性 Gate 全部通过后再删除旧路径。

## 18. 暂缓范围

Wave 0R 至 Wave 4R 完成前，禁止扩大多 Agent DAG 生产接入、question/docs/test 全场景迁移、自动 Exec fallback、删除旧 `executions/`、新增独立 SupervisorRun，或用纯 mock Canary 宣布产品闭环完成。

## 19. 最终完成定义

| 能力 | 硬性标准 |
|---|---|
| ExecutionRun | 唯一持久业务 Run |
| Supervisor | Run 扩展，不造第二 Run |
| 默认执行 | 原生 Codex TUI |
| `/goal` | 真实 PTY 两阶段输入且幂等 |
| Resume | native session ID + `codex resume` |
| 无人监管 | ChatGPT 离线后持续 checkpoint、纠偏和恢复 |
| 动态验收 | 运行中触发，不只 terminal |
| ChatGPT 接管 | 同一 worktree，无新 repair task |
| Evidence | 屏幕文字不能冒充事实 |
| Acceptance | 无 AcceptanceDecision 不得 completed |
| Projection | 失败必须 durable pending |
| Terminal | canonical decision + progression 唯一闭环 |
| Restart | Run、Attempt、Checkpoint、TUI session 全部可恢复 |
| Canary | 真实 TUI 全流程通过 |

## 20. 实施起点

```text
修正 Run 完成语义
-> 修正幂等与持久化
-> 修正默认 TUI 策略
-> 硬化 Provider 边界
-> 拆分 TUI Session Manager
-> 接入 Supervisor Plan/Checkpoint
-> 实现真实 /goal 与 native resume
```
