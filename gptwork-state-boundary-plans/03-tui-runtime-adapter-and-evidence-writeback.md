# TUI Runtime Adapter and Evidence Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Codex TUI 变成纯交互运行时适配器，并把 `collect` 收敛为“采集 evidence → finalizer → canonical task transition”的唯一边界。

**Architecture:** 保留现有 PTY/session store，但移除工具层直接状态决策。`codex_tui_collect` 调用统一 execution runtime collect，再通过独立 evidence application service 运行 finalizer 和 Task transition。Stop 只停止 session，不判断验收。

**Tech Stack:** Node.js ESM、PTY adapter、现有 TUI session store、统一 execution runtime、task finalizer。

## Global Constraints

- `codex_tui_stop` 不得把 Task 直接改为 repairing/completed。
- `codex_tui_collect` 必须幂等。
- 不解析 ANSI 屏幕作为完成依据。
- durable result artifacts + git evidence 是唯一 evidence 输入。
- TUI session status 不映射为 Task terminal status。
- 现有工具名保持不变。

---

## 文件结构

### 新建

- `backend/src/providers/codex-tui-execution-provider.mjs`
- `backend/src/executions/execution-evidence-application-service.mjs`
- `backend/src/codex-tui/codex-tui-session-status.mjs`
- `backend/test/codex-tui-execution-provider.test.mjs`
- `backend/test/execution-evidence-application-service.test.mjs`

### 修改

- `backend/src/tool-groups/codex-tui-tools-group.mjs`
- `backend/src/codex-tui-session-manager.mjs`
- `backend/src/codex-tui-session-store.mjs`
- `backend/src/codex-tui-completion-collector.mjs`
- `backend/src/codex-tui-evidence-writeback.mjs`
- `backend/src/codex-tui-evidence-cycle.mjs`
- `backend/src/codex-tui-runtime-diagnostics.mjs`
- `backend/test/codex-tui-collect-state-sync.test.mjs`
- `backend/test/full-tui-tool-transition.test.mjs`

---

## Task 1：定义 TUI session 自身状态

**Files:**
- Create: `backend/src/codex-tui/codex-tui-session-status.mjs`
- Modify: `backend/src/codex-tui-session-store.mjs`
- Test: `backend/test/codex-tui-session-store.test.mjs`

状态：

```js
export const TUI_SESSION_STATUSES = {
  CREATED: "created",
  STARTING: "starting",
  ACTIVE: "active",
  STOP_REQUESTED: "stop_requested",
  STOPPED: "stopped",
  FAILED: "failed",
  LOST: "lost",
};
```

Session 字段：

```js
{
  id,
  execution_id,
  provider_run_id,
  task_id,
  goal_id,
  cwd,
  status,
  active,
  process: {
    pid,
    started_at,
    ended_at,
    exit_code,
    signal,
  },
  interaction: {
    last_input_at,
    last_output_at,
    attached_clients,
  },
  terminal_reason,
}
```

删除或废弃语义：

- session `completed` 不再使用；历史读取映射为 `stopped`。
- session 不存 `ready_for_review`。
- session 的 `status=stopped` 不能推断 Task 状态。

---

## Task 2：实现 TUI provider adapter

**Files:**
- Create: `backend/src/providers/codex-tui-execution-provider.mjs`
- Modify: `backend/src/codex-tui-session-manager.mjs`
- Test: `backend/test/codex-tui-execution-provider.test.mjs`

实现：

```js
export function createCodexTuiExecutionProvider({
  sessionManager,
  completionCollector,
}) {
  return {
    name: "codex_tui",

    capabilities() {
      return {
        interactive: true,
        supports_send_input: true,
        supports_attach: true,
        supports_streaming_logs: true,
      };
    },

    async start({ execution, task, goal, cwd }) {
      const session = await sessionManager.start({
        task,
        goal,
        cwd,
        executionId: execution.id,
      });
      return {
        provider_run_id: session.id,
        runtime_details: {
          session_id: session.id,
          cwd,
        },
      };
    },

    async status({ execution }) {
      return sessionManager.status(execution.provider_run_id);
    },

    async stop({ execution }) {
      return sessionManager.stop(execution.provider_run_id);
    },

    async cancel({ execution }) {
      return sessionManager.stop(execution.provider_run_id, {
        reason: "cancelled",
      });
    },

    async collect({ execution }) {
      return completionCollector.collect({
        execution,
        sessionId: execution.provider_run_id,
      });
    },

    async readLogs({ execution, maxChars }) {
      return sessionManager.read(execution.provider_run_id, { maxChars });
    },
  };
}
```

Session manager：

- 接受 `executionId`。
- 持久化 `execution_id`。
- stop 只更新 session。
- 释放 PTY 资源由 provider/runtime service 负责。
- repo lock 最终释放由 execution runtime service 负责，不由 session manager 自行决定。

---

## Task 3：重构 completion collector 输出统一 evidence

**Files:**
- Modify: `backend/src/codex-tui-completion-collector.mjs`
- Test: `backend/test/codex-tui-completion-collector.test.mjs`
- Test: `backend/test/codex-tui-completion-collector-result-json.test.mjs`

拆函数：

```js
readTuiResultArtifacts(...)
collectTuiGitEvidence(...)
collectTuiVerificationEvidence(...)
buildRawTuiExecutionEvidence(...)
```

不要在 collector 中返回 `ready_for_review` 作为核心决策。兼容字段可暂时保留：

```js
return {
  ...evidence,
  compatibility: {
    ready_for_review: evidence.diagnostics.blockers.length === 0,
  },
};
```

最终直接返回统一 schema。

修复当前潜在问题：

1. `tests` 可能是数组、字符串、对象，必须规范化。
2. `verification.passed` 不能由“有 tests 文本”推断。
3. `worktree_clean` 应分别记录：
   - untracked
   - staged
   - unstaged
4. changed files 应包含 commit diff：
   ```bash
   git diff --name-status <base_commit>..<head_commit>
   ```
   不能只看当前 dirty status。
5. result artifact freshness：
   - 记录 mtime
   - 与 execution started_at 比较
   - 旧 artifact 标记 blocker
6. canonical goal dir 与 worktree fallback 必须记录来源，不能静默切换。

输出示例：

```js
{
  schema_version: 1,
  execution_id: execution.id,
  provider: "codex_tui",
  repository: {...},
  outcome: {...},
  changes: [...],
  verification: {...},
  artifacts: [...],
  integration: {...},
  diagnostics: {
    blockers: [
      {
        code: "verification_result_missing",
        message: "...",
        source: "codex_tui_completion_collector",
      }
    ],
    warnings: [],
  },
  provenance: {...},
}
```

---

## Task 4：建立 evidence application service

**Files:**
- Create: `backend/src/executions/execution-evidence-application-service.mjs`
- Modify: `backend/src/codex-tui-evidence-writeback.mjs`
- Test: `backend/test/execution-evidence-application-service.test.mjs`
- Test: `backend/test/codex-tui-evidence-writeback.test.mjs`

服务 API：

```js
createExecutionEvidenceApplicationService({
  taskTransitionService,
  taskFinalizer,
  evidenceNormalizer,
  executionStore,
  store,
})
```

主流程：

```js
async apply({ executionId }) {
  const execution = await executionStore.readExecution(executionId);
  const evidence = await executionStore.readEvidence(executionId);
  const task = await findTask(store, execution.task_id);
  const goal = await findGoal(...);
  const contract = await loadAcceptanceContract(goal);

  const normalized = normalizeOperationEvidence({
    result: executionEvidenceToTaskResult(evidence),
    contract,
  });

  const finalizerDecision = decideTaskFinalState({
    current_status: task.status,
    codex_result: normalized,
    task,
    verification: normalized.verification,
    contract_verification: normalized.blocking_evidence?.contract_verification,
    integration: normalized.integration,
    repair_budget: resolveRepairBudget(task),
  });

  const applied = applyTaskFinalStateDecision({
    taskStatus: task.status,
    taskResult: normalized,
    finalizerDecision,
  });

  const unifiedDecision = normalizeToUnifiedDecision({
    finalizerDecision,
    taskResult: applied.taskResult,
    task,
  });

  const canonicalStatus = unifiedDecision.status;

  return taskTransitionService.transitionTask({
    task_id: task.id,
    event: "canonical_decision_applied",
    expected_statuses: [
      "collecting",
      "waiting_for_review",
      "waiting_for_integration",
      "accepting",
    ],
    idempotency_key: `${executionId}:canonical:${digest(unifiedDecision)}`,
    source: "finalizer",
    reason: "execution evidence finalized",
    payload: {
      execution_id: executionId,
      evidence_ref: execution.evidence_ref,
      unified_decision: unifiedDecision,
      canonical_status: canonicalStatus,
      task_result_patch: {
        ...applied.taskResult,
        unified_decision: unifiedDecision,
      },
    },
  });
}
```

重要：

- `canonical_status` 必须来自 unified decision。
- 若 finalizer 返回 `waiting_for_repair`，Task 进入对应状态。
- 若 integration pending，进入 `waiting_for_integration`。
- 若 human review required，进入 typed review state。
- 不强制所有完整 evidence 都先经过 legacy `waiting_for_review`。

---

## Task 5：简化 MCP TUI tools

**Files:**
- Modify: `backend/src/tool-groups/codex-tui-tools-group.mjs`
- Test: `backend/test/codex-tui-tools-group.test.mjs`
- Test: `backend/test/codex-tui-collect-state-sync.test.mjs`
- Test: `backend/test/full-tui-tool-transition.test.mjs`

### `codex_tui_start_goal`

替换大段 worktree/lock/execution/session orchestration：

```js
handler: async ({ task_id }) => executionRuntime.start({
  request_id: randomUUID(),
  task_id,
  provider: "codex_tui",
  interaction_mode: "interactive",
})
```

### `codex_tui_status`

```js
handler: ({ session_id }) =>
  tuiToolFacade.statusBySessionId(session_id)
```

Facade 先从 session 找 execution，再组合返回：

```js
{
  mode: "tui",
  session: {...},
  execution: {...},
  task_projection: {
    task_id,
    status,
    canonical_outcome,
  },
}
```

### `codex_tui_stop`

当前 `reconcileStoppedTuiTask()` 直接把 Task 设为 collecting/repairing，应删除。

新逻辑：

```js
handler: async ({ session_id }) => {
  const execution = await executionLookup.bySessionId(session_id);
  const stopped = await executionRuntime.stop({
    execution_id: execution.id,
  });

  return {
    ...stopped,
    next_action: "call codex_tui_collect to collect durable evidence",
  };
}
```

若 stop 后发现无 evidence，不立刻 repair。由 collect/evidence cycle 决定。

### `codex_tui_collect`

```js
handler: async ({ session_id }) => {
  const execution = await executionLookup.bySessionId(session_id);
  const evidence = await executionRuntime.collect({
    execution_id: execution.id,
  });
  const application = await evidenceApplication.apply({
    execution_id: execution.id,
  });

  return {
    execution_id: execution.id,
    session_id,
    evidence,
    canonical_decision: application.task.result.unified_decision,
    task_status: application.task.status,
    idempotent_replay: application.idempotent_replay,
  };
}
```

删除工具层：

- `item.status = 'waiting_for_review'`
- 直接写 `item.result`
- 手动清 owner 的业务逻辑
- 以 `snapshot.ready_for_review` 决定 Task 状态

---

## Task 6：修正 evidence cycle 超时语义

**Files:**
- Modify: `backend/src/codex-tui-evidence-cycle.mjs`
- Test: `backend/test/codex-tui-evidence-cycle.test.mjs`

当前超时直接返回 Task 风格 `status: timed_out`。改为 execution evidence failure：

```js
{
  execution_status: "timed_out",
  evidence_ready: false,
  diagnostics: {
    blockers: [{
      code: "tui_result_json_timeout",
      retryable: true,
    }],
  },
}
```

是否让 Task timed_out，由 finalizer + repair budget 决定。

Freshness re-check：

- 使用注入的 `now()`，不要混用 `Date.now()`。
- 验证 artifact mtime >= execution.started_at。
- JSON terminal status 不足以证明 evidence 完整。

---

## Task 7：测试矩阵

必须覆盖：

1. start 成功：
   - execution=running
   - session=active
   - task=running
2. stop：
   - session=stopped
   - execution=stopping/stopped 或 collecting
   - task 不被直接改为 repair/completed
3. collect 完整 code change：
   - evidence_ready
   - finalizer completed 或 waiting_for_integration
4. collect no-change：
   - 有 no-change evidence 时允许通过
5. collect 缺 verification：
   - canonical decision 为 repair/review，不误 completed
6. 重复 collect：
   - 同一 transition event
   - 不重复 append activity
7. session orphan：
   - execution lost
   - task 由 finalizer/reconciler决定
8. 历史 session：
   - 没 execution_id 时建立 compatibility execution 或返回明确迁移诊断

运行：

```bash
cd backend
node --test \
  test/codex-tui-execution-provider.test.mjs \
  test/codex-tui-session-store.test.mjs \
  test/codex-tui-session-manager.test.mjs \
  test/codex-tui-completion-collector.test.mjs \
  test/codex-tui-completion-collector-result-json.test.mjs \
  test/codex-tui-evidence-cycle.test.mjs \
  test/codex-tui-evidence-writeback.test.mjs \
  test/execution-evidence-application-service.test.mjs \
  test/codex-tui-tools-group.test.mjs \
  test/codex-tui-collect-state-sync.test.mjs \
  test/full-tui-tool-transition.test.mjs
npm run check:syntax
npm run check:imports
```
