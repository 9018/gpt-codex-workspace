# 01 Canonical Decision 与状态主权修复方案

## 目标

修复 `codex-unified-decision.mjs` 的类型污染和 integration 假完成漏洞，并把 unified decision 升级为任务状态转移的唯一事实源。

## 主要文件

### 修改

- `backend/src/codex-unified-decision.mjs`
  - `firstOf`
  - `buildIntegrationEffect`
  - `deriveRequiresIntegration`
  - `deriveSafeToAutoAdvance`
  - `normalizeToUnifiedDecision`
  - `checkDecisionConsistency`
- `backend/src/task-finalizer.mjs`
- `backend/src/closure/task-closure-decider.mjs`
- `backend/src/task-final-writeback.mjs`
- `backend/src/goal-queue.mjs`
- `backend/src/queue-reconciler.mjs`
- `backend/src/pipeline-orchestration.mjs`
- `backend/src/workstream/task-outcome-summary.mjs`
- `backend/src/evidence/operation-evidence-profiles.mjs`

### 新增

- `backend/src/domain/task-outcome-semantics.mjs`
- `backend/src/domain/integration-semantics.mjs`
- `backend/src/domain/acceptance-semantics.mjs`
- `backend/src/domain/unified-decision-schema.mjs`
- `backend/src/domain/unified-decision-validator.mjs`

### 测试

- `backend/test/unified-decision-consistency.test.mjs`
- 新增 `backend/test/unified-decision-contract.test.mjs`
- 新增 `backend/test/unified-decision-integration-invariants.test.mjs`
- 新增 `backend/test/unified-decision-consumer-boundary.test.mjs`
- 修改 `backend/test/task-final-writeback.test.mjs`
- 修改 `backend/test/goal-queue.test.mjs`
- 修改 `backend/test/queue-auto-advance.test.mjs`

## 设计

### 决策输入

```js
{
  schema_version: 2,
  task_id,
  decision_revision,
  evidence_revision,
  facts: {
    provider,
    verification,
    acceptance,
    review,
    integration,
    delivery,
    closure
  }
}
```

### 决策输出

```js
{
  schema_version: 2,
  task_id,
  decision_revision,
  status,
  reason,
  blockers,
  repairable_blockers,
  requires_review,
  requires_repair,
  requires_integration,
  safe_to_auto_advance,
  effects: {
    task,
    goal,
    queue,
    workstream,
    integration
  },
  consistency: {
    valid,
    violations
  }
}
```

## 实施任务

### Task 1：冻结现有行为并复现两个已知漏洞

**测试内容：**

```js
test("firstOf preserves primitive values", () => {
  const d = normalizeToUnifiedDecision({
    finalizerDecision: { reason: "verification passed" }
  });
  assert.equal(d.reason, "verification passed");
});

test("completed cannot coexist with unsatisfied required integration", () => {
  const d = normalizeToUnifiedDecision({
    finalizerDecision: { status: "completed" },
    taskResult: {
      integration: { required: true, satisfied: false, terminal: false }
    }
  });
  assert.notEqual(d.status, "completed");
  assert.equal(d.safe_to_auto_advance, false);
  assert.equal(d.consistency.valid, true);
});
```

先运行并确认失败：

```bash
cd backend
node --test test/unified-decision-contract.test.mjs
```

### Task 2：修复 `firstOf`

替换为保留原始值的实现：

```js
function firstOf(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}
```

为字符串、数字、布尔值、数组、对象和空值分别写 contract test。

### Task 3：建立纯语义模块

`integration-semantics.mjs`：

```js
export function normalizeIntegrationFacts(raw = {}) {
  return {
    required: raw.required === true,
    satisfied: raw.satisfied === true,
    terminal: raw.terminal === true,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : []
  };
}

export function integrationAllowsCompletion(facts) {
  return !facts.required || (facts.satisfied && facts.terminal);
}
```

`acceptance-semantics.mjs`：

```js
export function acceptanceAllowsCompletion({ verification, acceptance, review }) {
  return verification?.passed === true
    && acceptance?.passed === true
    && review?.blocking_findings?.length === 0;
}
```

`task-outcome-semantics.mjs` 只组合事实，不读 store、不写文件。

### Task 4：定义强 schema 和验证器

验证规则至少包括：

- `reason` 必须是字符串或 `null`。
- `status=completed` 时 verification、acceptance 必须通过。
- integration required 时必须 satisfied 且 terminal。
- `safe_to_auto_advance=true` 时不得存在 blocker。
- `requires_repair` 与 `status=completed` 不得同时为 true。
- decision revision 和 evidence revision 必须存在。
- effect 不能要求互相矛盾的 task/goal 状态。

伪代码：

```js
export function validateUnifiedDecision(decision) {
  const violations = [];
  if (typeof decision.reason !== "string" && decision.reason !== null) {
    violations.push("reason_type_invalid");
  }
  if (decision.status === "completed" &&
      !integrationAllowsCompletion(decision.effects.integration)) {
    violations.push("completed_without_integration");
  }
  return { valid: violations.length === 0, violations };
}
```

### Task 5：让 consistency checker 成为强 gate

所有状态写回前执行：

```js
const validated = assertValidUnifiedDecision(decision);
await applyDecision(validated);
```

禁止：

```js
if (!decision.consistency.valid) logWarning();
```

要求改为抛出 typed error：

```js
throw new UnifiedDecisionInvariantError(violations);
```

错误进入 repair/reconcile，不得继续完成任务。

### Task 6：迁移消费者

逐个替换以下局部判断：

- `integrationSatisfied`
- `integrationIsSatisfied`
- `acceptedByReviewer`
- `acceptancePassed`
- `verificationPassed`
- `unresolvedBlockingFindings`

消费者只能读取：

```js
decision.status
decision.safe_to_auto_advance
decision.effects
decision.consistency
```

新增静态测试扫描，禁止关键消费者重新定义同义 helper。

### Task 7：引入 decision revision

每次 evidence 变化后：

```js
decision_revision = previous.decision_revision + 1
evidence_revision = currentEvidence.revision
```

写回时使用 compare-and-swap：

```js
if (stored.decision_revision !== expected_previous_revision) {
  throw new StaleDecisionError();
}
```

### Task 8：兼容旧字段但禁止旧字段参与决策

旧字段继续输出供 UI/历史数据读取，但标记：

```js
legacy_projection: true
```

新增测试确保修改 legacy 字段不会改变 canonical decision。

## 验收命令

```bash
cd backend
node --test test/unified-decision-contract.test.mjs
node --test test/unified-decision-integration-invariants.test.mjs
node --test test/unified-decision-consumer-boundary.test.mjs
node --test test/unified-decision-consistency.test.mjs
node --test test/task-final-writeback.test.mjs
node --test test/goal-queue.test.mjs test/queue-auto-advance.test.mjs
npm run check:syntax
npm run check:imports
```

## 完成标准

- 不再出现 primitive 被转换为 `{}`。
- integration 未满足时绝不允许 completed。
- queue、goal、workstream 只消费 validated unified decision。
- 任意矛盾决策都以 typed error 阻断写回。
- 旧字段只作为投影存在。
