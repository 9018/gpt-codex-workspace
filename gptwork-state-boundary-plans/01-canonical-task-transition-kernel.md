# Canonical Task Transition Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立唯一 Task 状态转换入口，禁止业务模块直接自由改写 Task 核心状态。

**Architecture:** 新增纯状态机定义、转换命令模型和原子持久化服务。现有 `updateTask()` 暂时保留为兼容层，但核心执行链逐步改为 `transitionTask()`。每次转换必须包含事件类型、期望前态、原因、证据引用和幂等键。

**Tech Stack:** Node.js ESM、内置 `node:test`、现有 StateStore、JSON durable state。

## Global Constraints

- 不改变现有公开 MCP 工具名称。
- 不在本阶段拆分部署进程。
- `task.result.unified_decision` 是 canonical outcome。
- 所有新转换必须幂等。
- 所有旧数据必须可读。
- 不允许一次转换同时重新推导 acceptance 和写 Queue。

---

## 文件结构

### 新建

- `backend/src/task-state/task-state-model.mjs`
  - 状态分类、允许转换图、事件到目标状态映射。
- `backend/src/task-state/task-transition-command.mjs`
  - 转换命令校验与规范化。
- `backend/src/task-state/task-transition-service.mjs`
  - 原子加载、前置条件校验、写入、事件记录。
- `backend/src/task-state/task-transition-errors.mjs`
  - 稳定错误码。
- `backend/src/task-state/task-transition-events.mjs`
  - 标准领域事件定义。
- `backend/test/task-transition-service.test.mjs`
- `backend/test/task-transition-matrix.test.mjs`

### 修改

- `backend/src/task-status-taxonomy.mjs`
  - 只保留分类与兼容导出，不承担转换逻辑。
- `backend/src/task-lifecycle.mjs:147-198`
  - 将 `updateTask()` 标记为兼容 API；新增调用 transition service 的适配函数。
- `backend/src/state-store.mjs`
  - 确认或新增 compare-and-set / mutate 原子能力。
- `backend/src/server-tools.mjs`
  - 注入 transition service。
- `backend/scripts/check-syntax.mjs`
  - 纳入新目录。

---

## Task 1：定义状态模型与转换矩阵

**Files:**
- Create: `backend/src/task-state/task-state-model.mjs`
- Modify: `backend/src/task-status-taxonomy.mjs`
- Test: `backend/test/task-transition-matrix.test.mjs`

**Interfaces:**
- Produces:
  - `TASK_PHASES`
  - `TASK_EVENTS`
  - `TASK_TRANSITION_MATRIX`
  - `resolveTaskTransition({ currentStatus, event, payload })`
  - `canTransitionTask({ currentStatus, event })`

- [ ] **Step 1: 写失败测试**

测试至少覆盖：

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTaskTransition,
  canTransitionTask,
} from "../src/task-state/task-state-model.mjs";

test("execution evidence ready moves running task to waiting_for_review", () => {
  assert.equal(
    resolveTaskTransition({
      currentStatus: "running",
      event: "execution_evidence_ready",
      payload: { canonical_status: "waiting_for_review" },
    }).nextStatus,
    "waiting_for_review",
  );
});

test("runtime session stop does not decide task acceptance", () => {
  const result = resolveTaskTransition({
    currentStatus: "running",
    event: "execution_session_stopped",
    payload: { evidence_available: true },
  });
  assert.equal(result.nextStatus, "collecting");
});

test("terminal task cannot regress to running", () => {
  assert.equal(
    canTransitionTask({
      currentStatus: "completed",
      event: "execution_started",
    }),
    false,
  );
});

test("canonical decision completed may close review state", () => {
  assert.equal(
    resolveTaskTransition({
      currentStatus: "waiting_for_review",
      event: "canonical_decision_applied",
      payload: { canonical_status: "completed" },
    }).nextStatus,
    "completed",
  );
});
```

- [ ] **Step 2: 实现明确的事件集合**

建议事件：

```js
export const TASK_EVENTS = Object.freeze({
  EXECUTION_CLAIMED: "execution_claimed",
  EXECUTION_STARTED: "execution_started",
  EXECUTION_STOP_REQUESTED: "execution_stop_requested",
  EXECUTION_SESSION_STOPPED: "execution_session_stopped",
  EXECUTION_EVIDENCE_COLLECTION_STARTED: "execution_evidence_collection_started",
  EXECUTION_EVIDENCE_READY: "execution_evidence_ready",
  EXECUTION_EVIDENCE_FAILED: "execution_evidence_failed",
  CANONICAL_DECISION_APPLIED: "canonical_decision_applied",
  REPAIR_SCHEDULED: "repair_scheduled",
  INTEGRATION_STARTED: "integration_started",
  INTEGRATION_COMPLETED: "integration_completed",
  CANCEL_REQUESTED: "cancel_requested",
  RUNTIME_LOST: "runtime_lost",
  RECONCILIATION_CORRECTION: "reconciliation_correction",
});
```

转换原则：

```js
const MATRIX = {
  assigned: {
    execution_claimed: "starting",
    execution_started: "running",
    cancel_requested: "cancelled",
  },
  starting: {
    execution_started: "running",
    execution_evidence_failed: "failed",
    runtime_lost: "waiting_for_repair",
  },
  running: {
    execution_session_stopped: "collecting",
    execution_evidence_collection_started: "collecting",
    cancel_requested: "cancelled",
    runtime_lost: "waiting_for_repair",
  },
  collecting: {
    execution_evidence_ready: ({ payload }) => payload.canonical_status ?? "waiting_for_review",
    execution_evidence_failed: ({ payload }) => payload.repairable ? "waiting_for_repair" : "failed",
  },
  waiting_for_review: {
    canonical_decision_applied: ({ payload }) => payload.canonical_status,
  },
  waiting_for_repair: {
    repair_scheduled: "assigned",
    cancel_requested: "cancelled",
  },
  waiting_for_integration: {
    integration_started: "integrating",
    canonical_decision_applied: ({ payload }) => payload.canonical_status,
  },
  integrating: {
    integration_completed: ({ payload }) => payload.canonical_status,
  },
};
```

终态默认拒绝所有转换，只有显式 `reconciliation_correction` 且携带管理员审计信息时允许修正。

- [ ] **Step 3: 与 taxonomy 对齐**

`task-status-taxonomy.mjs` 中：

- 保留 `TASK_STATUSES`。
- 新增 `TRANSITIONAL_STATUSES`：
  - `starting`
  - `running`
  - `collecting`
  - `accepting`
  - `repairing`
  - `integrating`
- 保持 typed review 状态兼容。
- 删除任何暗示“waiting_for_review 是 session terminal”的注释。
- `task-status.mjs` 中的 `TASK_STATUS_TERMINAL_FOR_SESSION_INVENTORY` 改名为 `TASK_STATUS_STOPPABLE_FOR_SESSION_INVENTORY`，避免领域误导。

- [ ] **Step 4: 运行测试**

```bash
cd backend
node --test test/task-transition-matrix.test.mjs
npm run check:syntax
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/src/task-state backend/src/task-status-taxonomy.mjs backend/src/task-status.mjs backend/test/task-transition-matrix.test.mjs
git commit -m "feat(state): define canonical task transition matrix"
```

---

## Task 2：定义转换命令与稳定错误码

**Files:**
- Create: `backend/src/task-state/task-transition-command.mjs`
- Create: `backend/src/task-state/task-transition-errors.mjs`
- Test: `backend/test/task-transition-service.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeTaskTransitionCommand(input)`
  - `TaskTransitionError`
  - error codes:
    - `task_not_found`
    - `task_transition_invalid`
    - `task_transition_conflict`
    - `task_transition_idempotency_conflict`
    - `task_transition_missing_canonical_decision`

命令结构：

```js
{
  task_id: "task_x",
  event: "execution_evidence_ready",
  expected_statuses: ["running", "collecting"],
  payload: {
    canonical_status: "waiting_for_review",
    execution_id: "exec_x",
    evidence_ref: ".gptwork/executions/exec_x/evidence.json",
  },
  reason: "durable evidence collected",
  source: "codex_tui",
  actor: {
    type: "system",
    id: "codex_tui_collect",
  },
  idempotency_key: "exec_x:evidence:v1",
  occurred_at: "ISO timestamp",
}
```

校验规则：

```js
if (!task_id) throw error("task_transition_invalid");
if (!TASK_EVENTS[event]) throw error("task_transition_invalid");
if (!idempotency_key) throw error("task_transition_invalid");
if (event === "canonical_decision_applied" && !payload?.unified_decision) {
  throw error("task_transition_missing_canonical_decision");
}
```

要求：

- `expected_statuses` 必须是数组。
- `payload` 必须可 JSON 序列化。
- 禁止 payload 覆盖 `task.id`、`created_at`。
- `source` 使用稳定枚举：`codex_exec`、`codex_tui`、`finalizer`、`workflow`、`reconciler`、`operator`。

测试加入：

- 缺失幂等键失败。
- 非法事件失败。
- canonical decision 没有 `unified_decision` 失败。
- 时间戳缺失时自动补齐。
- 输入对象不被修改。

---

## Task 3：实现原子 transition service

**Files:**
- Create: `backend/src/task-state/task-transition-service.mjs`
- Modify: `backend/src/state-store.mjs`
- Test: `backend/test/task-transition-service.test.mjs`

**Interfaces:**
- Produces:

```ts
transitionTask(command): Promise<{
  applied: boolean;
  idempotent_replay: boolean;
  task: object;
  previous_status: string;
  next_status: string;
  event_record: object;
}>
```

核心伪代码：

```js
export function createTaskTransitionService({ store, now = () => new Date().toISOString(), emit }) {
  return {
    async transitionTask(input) {
      const command = normalizeTaskTransitionCommand(input);

      let result;
      await store.mutate(async (state) => {
        state.task_transition_events ||= [];
        state.task_transition_idempotency ||= {};

        const previousEventId =
          state.task_transition_idempotency[command.idempotency_key];

        if (previousEventId) {
          const event = state.task_transition_events.find(
            (item) => item.id === previousEventId,
          );
          result = {
            applied: false,
            idempotent_replay: true,
            task: state.tasks.find((t) => t.id === command.task_id),
            previous_status: event.previous_status,
            next_status: event.next_status,
            event_record: event,
          };
          return;
        }

        const task = state.tasks.find((t) => t.id === command.task_id);
        if (!task) throw new TaskTransitionError("task_not_found");

        if (
          command.expected_statuses.length > 0 &&
          !command.expected_statuses.includes(task.status)
        ) {
          throw new TaskTransitionError("task_transition_conflict", {
            expected: command.expected_statuses,
            actual: task.status,
          });
        }

        const resolved = resolveTaskTransition({
          currentStatus: task.status,
          event: command.event,
          payload: command.payload,
        });

        const previousStatus = task.status;
        task.status = resolved.nextStatus;
        task.updated_at = now();

        applyPermittedTaskPatch(task, command);

        const event = {
          id: `transition_${randomUUID()}`,
          task_id: task.id,
          event: command.event,
          previous_status: previousStatus,
          next_status: task.status,
          source: command.source,
          actor: command.actor,
          reason: command.reason,
          payload_digest: sha256(stableJson(command.payload)),
          evidence_ref: command.payload?.evidence_ref ?? null,
          execution_id: command.payload?.execution_id ?? null,
          idempotency_key: command.idempotency_key,
          occurred_at: command.occurred_at,
          persisted_at: now(),
        };

        state.task_transition_events.push(event);
        state.task_transition_idempotency[command.idempotency_key] = event.id;

        state.activities ||= [];
        state.activities.push({
          time: event.persisted_at,
          type: "task.transitioned",
          task_id: task.id,
          event: command.event,
          previous_status: previousStatus,
          status: task.status,
        });

        result = {
          applied: true,
          idempotent_replay: false,
          task: structuredClone(task),
          previous_status: previousStatus,
          next_status: task.status,
          event_record: event,
        };
      });

      if (result.applied) await emit?.(result.event_record, result.task);
      return result;
    },
  };
}
```

`applyPermittedTaskPatch()` 只能修改：

- `result`
- `metadata.execution_id`
- `metadata.active_execution_id`
- `metadata.last_evidence_ref`
- `metadata.last_transition_id`
- `logs`
- `completed_at` / `failed_at` / `cancelled_at`

禁止修改：

- `id`
- `goal_id`
- `workstream_id`
- `created_at`
- `assignee`
- repo identity 字段

StateStore：

- 若已有 `mutate(fn)`，明确其锁与保存语义。
- 若测试 store 只实现 `load/save`，提供 `createStoreMutationAdapter(store)`，不要在业务模块中判断 `store.mutate` 是否存在。
- 统一兼容测试 fake store。

---

## Task 4：将 updateTask 降级为兼容入口

**Files:**
- Modify: `backend/src/task-lifecycle.mjs:147-198`
- Create: `backend/src/task-state/legacy-update-task-adapter.mjs`
- Test: `backend/test/task-lifecycle.test.mjs`

策略：

```js
export async function updateTask(store, taskId, updater, options = {}) {
  if (options.transition_command) {
    return options.transition_service.transitionTask(options.transition_command);
  }

  // Legacy path. Retain behavior temporarily.
  // Add audit marker and reject direct terminal regression.
  return legacyUpdateTask(store, taskId, updater);
}
```

兼容路径必须：

- 记录 `metadata.legacy_direct_status_write_count`。
- 如果从 terminal 回到 active，直接抛错。
- 在开发/测试环境写 warning：
  - `[state-boundary] legacy direct task status mutation`
- 不自动改变 Queue。

新增静态检查测试：

```js
test("core runtime modules do not assign task.status directly", async () => {
  const forbidden = [
    "src/tool-groups/codex-tui-tools-group.mjs",
    "src/codex-tui-evidence-writeback.mjs",
    "src/executions/execution-service.mjs",
  ];
  // read files and reject /task\.status\s*=|item\.status\s*=/
});
```

本阶段只对新改造模块设禁令，不立即覆盖整个仓库。

---

## Task 5：注入服务并建立回归门

**Files:**
- Modify: `backend/src/server-tools.mjs`
- Modify: `backend/src/gptwork-server.mjs` 或实际 composition root
- Modify: `backend/src/tool-groups/codex-tui-tools-group.mjs`
- Test: `backend/test/public-tool-names.test.mjs`
- Test: `backend/test/task-transition-service.test.mjs`

Composition root：

```js
const taskTransitionService = createTaskTransitionService({
  store,
  emit: lifecycleEmitter,
});

createCodexTuiToolsGroup({
  ...deps,
  taskTransitionService,
});
```

验收命令：

```bash
cd backend
node --test \
  test/task-transition-matrix.test.mjs \
  test/task-transition-service.test.mjs \
  test/task-lifecycle.test.mjs \
  test/public-tool-names.test.mjs
npm run check:syntax
npm run check:imports
```

完成标准：

- 新核心路径不直接写 task status。
- 重复命令不重复写事件。
- 非法回退被拒绝。
- 现有公开工具集合不变。
