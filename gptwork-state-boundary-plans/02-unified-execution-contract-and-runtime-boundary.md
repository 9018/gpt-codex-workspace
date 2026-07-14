# Unified Execution Contract and Runtime Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex Exec 与 Codex TUI 定义共享执行协议，使两种模式只在 runtime 层不同，Task/Acceptance/Workflow 只消费统一证据。

**Architecture:** 把现有 `executions/execution-service.mjs` 从“默认启动 TUI”改造成 provider-neutral orchestration service；新增执行请求、运行态、证据和 provider adapter 协议。TUI 与 Exec 都实现同一接口。

**Tech Stack:** Node.js ESM、JSON Schema 风格手写校验、现有 worktree/repo-lock/execution-store。

## Global Constraints

- Execution status 与 Task status 分离。
- Execution store 不写 Task status。
- Provider 不直接写 Goal/Queue/Workflow。
- 所有 provider 最终输出同一 `ExecutionEvidence`。
- execution record ID 每次执行唯一，不使用固定 `exec_${taskId}`。
- 保持历史 execution record 可读。

---

## 文件结构

### 新建

- `backend/src/executions/execution-contract.mjs`
- `backend/src/executions/execution-status-taxonomy.mjs`
- `backend/src/executions/execution-provider-interface.mjs`
- `backend/src/executions/execution-evidence-schema.mjs`
- `backend/src/executions/execution-evidence-normalizer.mjs`
- `backend/src/executions/execution-runtime-service.mjs`
- `backend/test/execution-contract.test.mjs`
- `backend/test/execution-runtime-service.test.mjs`
- `backend/test/execution-evidence-normalizer.test.mjs`

### 修改

- `backend/src/executions/execution-store.mjs`
- `backend/src/executions/execution-service.mjs`
- `backend/src/codex-execution-provider.mjs`
- `backend/src/orchestration/execution-capacity.mjs`
- `backend/src/task-repo-resolution.mjs`

---

## Task 1：定义 ExecutionRequest 和 ExecutionRecord

**Files:**
- Create: `backend/src/executions/execution-contract.mjs`
- Create: `backend/src/executions/execution-status-taxonomy.mjs`
- Test: `backend/test/execution-contract.test.mjs`

请求模型：

```js
{
  request_id: "request_uuid",
  task_id: "task_x",
  goal_id: "goal_x",
  workstream_id: "ws_x",
  provider: "codex_exec" | "codex_tui",
  interaction_mode: "batch" | "interactive",
  workspace_id: "hosted-default",
  repo_id: "github.com-9018-gpt-codex-workspace",
  context_ref: ".gptwork/goals/goal_x/codex.entry.md",
  acceptance_contract_ref: ".gptwork/goals/goal_x/acceptance.contract.json",
  timeout_ms: 7200000,
  resource_budget: {
    concurrency_units: 1,
    max_output_bytes: 10485760,
  },
  metadata: {},
}
```

Execution 状态：

```js
export const EXECUTION_STATUSES = {
  CREATED: "created",
  PREPARING: "preparing",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  COLLECTING: "collecting",
  EVIDENCE_READY: "evidence_ready",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  LOST: "lost",
};
```

明确：

- `evidence_ready` 表示可交给 finalizer，不代表 Task accepted。
- `completed` 表示 runtime 生命周期完成，不代表 Task `completed`。
- TUI 的 interactive/attached 不放入核心状态，放 `runtime_details`.

校验函数：

```js
validateExecutionRequest(input)
normalizeExecutionRequest(input)
isTerminalExecutionStatus(status)
canTransitionExecution(from, to)
```

---

## Task 2：定义统一 ExecutionEvidence

**Files:**
- Create: `backend/src/executions/execution-evidence-schema.mjs`
- Create: `backend/src/executions/execution-evidence-normalizer.mjs`
- Test: `backend/test/execution-evidence-normalizer.test.mjs`

结构：

```js
{
  schema_version: 1,
  evidence_id: "evidence_uuid",
  execution_id: "execution_uuid",
  provider: "codex_exec" | "codex_tui",
  task_id: "task_x",
  goal_id: "goal_x",

  runtime: {
    started_at: "...",
    ended_at: "...",
    duration_ms: 1000,
    exit_code: 0,
    termination_reason: "completed",
  },

  repository: {
    canonical_repo_path: "...",
    worktree_path: "...",
    branch: "...",
    base_commit: "...",
    head_commit: "...",
    worktree_clean: true,
  },

  outcome: {
    reported_status: "completed",
    summary: "...",
    operation_kind: "code_change",
    no_change_reason: null,
  },

  changes: [
    { path: "backend/src/x.mjs", status: "modified" }
  ],

  verification: {
    passed: true,
    commands: [
      {
        cmd: "node --test test/x.test.mjs",
        exit_code: 0,
        passed: true,
        output_ref: ".gptwork/executions/x/test-1.log",
      }
    ],
  },

  artifacts: [
    {
      kind: "result_json",
      path: ".gptwork/goals/goal_x/result.json",
      sha256: "...",
      fresh: true,
    }
  ],

  integration: {
    required: true,
    status: "pending",
    satisfied: false,
    commit: "...",
  },

  diagnostics: {
    warnings: [],
    blockers: [],
  },

  provenance: {
    collected_at: "...",
    collector: "codex_tui_completion_collector",
    source_refs: [],
  },
}
```

规范化规则：

- `changed_files: string[]` 转成 `changes[]`。
- `tests: string` 转成单条 verification command，但 `passed` 不能仅因字符串存在而推断为 true；必须有 exit code 或 provider 明确结果。
- dirty worktree 必须写 blocker。
- code change 有 changes 但没有 head commit，写 blocker。
- no-change 必须有 `no_change_reason` 或 diagnostic artifact。
- 不在 normalizer 中决定 Task status。

---

## Task 3：定义 provider interface

**Files:**
- Create: `backend/src/executions/execution-provider-interface.mjs`
- Test: `backend/test/execution-contract.test.mjs`

Provider API：

```ts
interface ExecutionProvider {
  name: "codex_exec" | "codex_tui";

  capabilities(): {
    interactive: boolean;
    supports_send_input: boolean;
    supports_attach: boolean;
    supports_streaming_logs: boolean;
  };

  start(input: {
    execution: ExecutionRecord;
    request: ExecutionRequest;
    task: object;
    goal: object;
    cwd: string;
  }): Promise<{
    provider_run_id: string;
    runtime_details: object;
  }>;

  status(input: {
    execution: ExecutionRecord;
  }): Promise<ProviderStatus>;

  stop(input): Promise<ProviderStopResult>;
  cancel(input): Promise<ProviderStopResult>;
  collect(input): Promise<ExecutionEvidence>;
  readLogs(input): Promise<{ text: string; cursor?: string }>;
}
```

运行时服务启动时调用：

```js
assertExecutionProvider(provider) {
  for (const method of ["start", "status", "stop", "cancel", "collect", "readLogs"]) {
    if (typeof provider[method] !== "function") throw ...
  }
}
```

---

## Task 4：升级 execution store

**Files:**
- Modify: `backend/src/executions/execution-store.mjs`
- Test: `backend/test/execution-service.test.mjs`
- Test: `backend/test/execution-runtime-service.test.mjs`

改动：

1. `executionId` 默认始终随机：
   ```js
   exec_${randomUUID()}
   ```
2. 添加字段：
   - `schema_version`
   - `provider`
   - `interaction_mode`
   - `provider_run_id`
   - `request`
   - `runtime_details`
   - `evidence_ref`
   - `transition_history`
3. `updateExecution()` 校验状态转换。
4. 新增：
   ```js
   appendTransition(executionId, transition)
   attachEvidence(executionId, evidence)
   findLatestExecutionForTask(taskId, { provider })
   ```
5. Evidence 单独存：
   ```text
   .gptwork/executions/<execution_id>.evidence.json
   ```
6. atomic write 保持临时文件 + rename。
7. 旧 record 没有 `schema_version` 时按 v0 读取并在内存补默认值，不自动重写。

---

## Task 5：建立 provider-neutral runtime service

**Files:**
- Create: `backend/src/executions/execution-runtime-service.mjs`
- Modify: `backend/src/executions/execution-service.mjs`
- Test: `backend/test/execution-runtime-service.test.mjs`

职责：

```js
createExecutionRuntimeService({
  store,
  config,
  executionStore,
  providerRegistry,
  repositoryPlanner,
  worktreeManager,
  repoLockManager,
  taskTransitionService,
})
```

主流程伪代码：

```js
async start(requestInput) {
  const request = normalizeExecutionRequest(requestInput);
  const { task, goal } = await loadTaskGoal(request);
  const provider = providerRegistry.get(request.provider);

  await taskTransitionService.transitionTask({
    task_id: task.id,
    event: "execution_claimed",
    expected_statuses: ["assigned", "queued", "waiting_for_repair"],
    idempotency_key: `${request.request_id}:claim`,
    source: request.provider,
    payload: {},
  });

  const plan = await repositoryPlanner.resolve({ task, goal, request });
  const materialized = await worktreeManager.materialize(plan);
  const lock = await repoLockManager.acquire(...);

  const execution = await executionStore.createExecution({
    ...identity,
    provider: request.provider,
    interactionMode: request.interaction_mode,
    request,
    status: "starting",
  });

  try {
    const started = await provider.start({
      execution,
      request,
      task,
      goal,
      cwd: materialized.worktree_path,
    });

    await executionStore.updateExecution(execution.id, {
      status: "running",
      provider_run_id: started.provider_run_id,
      runtime_details: started.runtime_details,
    });

    await taskTransitionService.transitionTask({
      task_id: task.id,
      event: "execution_started",
      expected_statuses: ["starting"],
      idempotency_key: `${execution.id}:started`,
      source: request.provider,
      payload: { execution_id: execution.id },
    });

    return ...
  } catch (error) {
    await executionStore.updateExecution(execution.id, {
      status: "failed",
      error: serializeError(error),
    });
    await repoLockManager.release(...);
    throw error;
  }
}
```

Collect：

```js
async collect({ executionId }) {
  const execution = await executionStore.readExecution(executionId);
  const provider = providerRegistry.get(execution.provider);

  await executionStore.updateExecution(executionId, { status: "collecting" });

  await taskTransitionService.transitionTask({
    task_id: execution.task_id,
    event: "execution_evidence_collection_started",
    expected_statuses: ["running", "collecting"],
    idempotency_key: `${executionId}:collect:start`,
    source: execution.provider,
    payload: { execution_id: executionId },
  });

  const raw = await provider.collect({ execution });
  const evidence = normalizeExecutionEvidence(raw);

  await executionStore.attachEvidence(executionId, evidence);
  await executionStore.updateExecution(executionId, {
    status: evidence.diagnostics.blockers.length
      ? "failed"
      : "evidence_ready",
  });

  return evidence;
}
```

注意：此处不调用 finalizer，也不把 Task 改成 completed。

---

## Task 6：容量模型统一使用 execution

**Files:**
- Modify: `backend/src/orchestration/execution-capacity.mjs`
- Modify: `backend/src/codex-tui-runtime-diagnostics.mjs`
- Test: `backend/test/execution-runtime-service.test.mjs`
- Test: `backend/test/codex-tui-runtime-diagnostics.test.mjs`

规则：

- 全局 active count 来自 execution records 状态：
  - preparing / starting / running / stopping / collecting
- TUI 容量按 provider=`codex_tui`。
- Exec 容量按 provider=`codex_exec`。
- per-repo 和 per-workstream 都读 execution identity。
- Queue 的 `running` 不再作为真实 runtime 数量，只是调度投影。

新增返回：

```js
{
  active_executions: 4,
  by_provider: { codex_exec: 3, codex_tui: 1 },
  by_repo: {},
  by_workstream: {},
  orphaned_active_executions: [],
}
```

---

## Task 7：验收

运行：

```bash
cd backend
node --test \
  test/execution-contract.test.mjs \
  test/execution-service.test.mjs \
  test/execution-runtime-service.test.mjs \
  test/execution-evidence-normalizer.test.mjs \
  test/codex-tui-runtime-diagnostics.test.mjs
npm run check:syntax
npm run check:imports
```

完成标准：

- 同一 task 可有多个 execution，ID 不冲突。
- Exec/TUI evidence schema 相同。
- runtime service 不直接设置 Task `completed`。
- capacity 不依赖 Queue 伪运行态。
- 旧 execution JSON 仍可读取。
