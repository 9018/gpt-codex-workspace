# Execution OS 代码级重构实施方案

基准提交：`main@1d818da`。绝对行号以此提交为准；代码变化后应使用“文件路径 + 函数名”重新定位。

## 1. 最终主链路

```text
User Request
  -> ExecutionIntent
  -> ExecutionPlan / DAG
  -> ExecutionRun
  -> ExecutionAttempt
  -> Provider
  -> EvidenceBundle
  -> AcceptanceDecision
  -> Delivery / Integration
  -> Task / Goal / Workstream Projection
```

核心规则：

- `ExecutionRun` 是业务执行的唯一真实状态。
- `ExecutionAttempt` 是某 Provider 的一次尝试，一个 Run 可包含多个 Attempt。
- Provider 只负责启动、观察、停止、收集原始证据，不得决定 Task/Goal 完成。
- Evidence 是唯一可信完成依据。
- AcceptanceDecision 是唯一验收决策。
- Task、Goal、Workstream 只从 Run 投影状态。

## 2. 当前代码重复点

当前存在两套相近执行模型：

- `backend/src/execution/*`：Attempt、Provider、Orchestrator。
- `backend/src/executions/*`：ExecutionRequest、ExecutionRuntimeService、ExecutionStore。
- `backend/src/task-processing/*`：Task 入口、Provider 分发、结果归一化。
- `backend/src/acceptance/*`：合同与 Profile。
- `backend/src/ephemeral-execution/*`：只读问询旁路。
- `backend/src/orchestration/*`：DAG、fan-out/join、多 Agent。

重构采用渐进迁移：新增统一内核，旧入口通过适配器调用，不立即删除旧 API。

## 3. 新增统一内核目录

```text
backend/src/execution-core/
├── execution-intent-schema.mjs
├── execution-intent-classifier.mjs
├── execution-plan-schema.mjs
├── execution-plan-compiler.mjs
├── execution-run-schema.mjs
├── execution-run-store.mjs
├── execution-run-service.mjs
├── execution-state-machine.mjs
├── execution-event-schema.mjs
├── execution-event-store.mjs
├── execution-projection-service.mjs
├── execution-recovery-service.mjs
├── execution-result-schema.mjs
├── operation-profile-registry.mjs
└── legacy-task-adapter.mjs
```

## 4. ExecutionIntent

### 新增 `backend/src/execution-core/execution-intent-schema.mjs`

```javascript
export const OPERATION_KINDS = Object.freeze([
  "code_change",
  "docs_change",
  "test_only",
  "question",
  "diagnostic",
  "code_review",
  "planning",
  "config_change",
  "runtime_operation",
  "external_operation",
]);

export const MUTATION_SCOPES = Object.freeze([
  "none",
  "repo",
  "filesystem",
  "runtime",
  "external_system",
]);

export function normalizeExecutionIntent(input = {}) {
  if (!input.request_text?.trim()) {
    throw new Error("request_text is required");
  }

  return {
    id: input.id || createId("intent"),
    request_text: input.request_text.trim(),
    operation_kind: input.operation_kind,
    mutation_scope: input.mutation_scope,
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    workstream_id: input.workstream_id || null,
    expected_outputs: input.expected_outputs || [],
    constraints: input.constraints || {},
    acceptance_profile: input.acceptance_profile || input.operation_kind,
    execution_policy: {
      preferred_provider: input.execution_policy?.preferred_provider || "auto",
      fallback_allowed: input.execution_policy?.fallback_allowed !== false,
      interaction_mode: input.execution_policy?.interaction_mode || "automatic",
      max_attempts: input.execution_policy?.max_attempts ?? 3,
    },
    context_policy: {
      max_tokens: input.context_policy?.max_tokens ?? 1_310_720,
      retrieval_mode: input.context_policy?.retrieval_mode || "indexed",
      include_history: input.context_policy?.include_history !== false,
    },
    created_at: input.created_at || new Date().toISOString(),
  };
}
```

此文件只能校验和规范化输入，禁止选择 Provider、创建 worktree、修改 Task、执行命令或判断完成。

### 新增 `backend/src/execution-core/execution-intent-classifier.mjs`

```javascript
export function classifyExecutionIntent(input = {}) {
  const text = String(input.request_text || "").toLowerCase();

  if (input.operation_kind) return normalizeExplicitIntent(input);

  if (containsAny(text, ["修改代码", "修复", "实现", "refactor"])) {
    return { operation_kind: "code_change", mutation_scope: "repo", confidence: "high" };
  }
  if (containsAny(text, ["更新文档", "修改文档", "readme", "docs"])) {
    return { operation_kind: "docs_change", mutation_scope: "repo", confidence: "high" };
  }
  if (containsAny(text, ["运行测试", "测试代码", "test", "coverage"])) {
    return { operation_kind: "test_only", mutation_scope: "none", confidence: "high" };
  }
  if (containsAny(text, ["分析", "是什么", "为什么", "距离产品化"])) {
    return { operation_kind: "question", mutation_scope: "none", confidence: "medium" };
  }
  return {
    operation_kind: "question",
    mutation_scope: "none",
    confidence: "low",
    requires_planner_confirmation: true,
  };
}
```

## 5. 修改 Execution Contract

文件：`backend/src/executions/execution-contract.mjs`

当前关键区域：

- 约第 13 行：`EXECUTION_PROVIDERS`
- 约第 16 行：`INTERACTION_MODES`
- 约第 29–57 行：`validateExecutionRequest`
- 约第 68–91 行：`normalizeExecutionRequest`

当前问题：强制 `task_id` 和 `provider`，导致问询无法自然进入主链路，Provider 选择过早，旧语义 `codex_tui_goal` 与 `codex_tui` 分散转换。

改为：

```javascript
export function validateExecutionRequest(input) {
  const errors = [];
  if (!input?.intent_id && !input?.intent) {
    errors.push("intent_id or intent is required");
  }
  if (input.task_id != null && typeof input.task_id !== "string") {
    errors.push("task_id must be a string when provided");
  }
  const requestedProvider =
    input.execution_policy?.preferred_provider || input.provider || "auto";
  if (!["auto", "codex_exec", "codex_tui"].includes(requestedProvider)) {
    errors.push("preferred_provider is invalid");
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeExecutionRequest(input) {
  assertValid(input);
  return {
    request_id: input.request_id || createRequestId(),
    intent_id: input.intent_id || input.intent.id,
    intent: input.intent || null,
    task_id: input.task_id || null,
    goal_id: input.goal_id || null,
    workstream_id: input.workstream_id || null,
    execution_policy: {
      preferred_provider:
        input.execution_policy?.preferred_provider || input.provider || "auto",
      fallback_allowed: input.execution_policy?.fallback_allowed !== false,
      interaction_mode:
        input.execution_policy?.interaction_mode || input.interaction_mode || "automatic",
    },
    context_ref: input.context_ref || null,
    acceptance_contract_ref: input.acceptance_contract_ref || null,
    timeout_ms: normalizeTimeout(input.timeout_ms),
    resource_budget: normalizeResourceBudget(input.resource_budget),
    metadata: structuredClone(input.metadata || {}),
  };
}
```

保留旧字段为兼容输入，内部只使用 `execution_policy`。

## 6. ExecutionRun 与 ExecutionAttempt

### 新增 `backend/src/execution-core/execution-run-schema.mjs`

```javascript
export const EXECUTION_RUN_STATES = Object.freeze([
  "created",
  "planning",
  "ready",
  "running",
  "collecting",
  "evaluating",
  "waiting_for_repair",
  "waiting_for_review",
  "waiting_for_integration",
  "completed",
  "failed",
  "cancelled",
]);

export function createExecutionRun(input) {
  return {
    id: input.id || createId("run"),
    intent_id: input.intent_id,
    goal_id: input.goal_id || null,
    task_id: input.task_id || null,
    workstream_id: input.workstream_id || null,
    plan_id: input.plan_id || null,
    acceptance_contract_id: input.acceptance_contract_id || null,
    state: "created",
    outcome: null,
    active_attempt_id: null,
    attempt_ids: [],
    workspace_ref: null,
    context_ref: null,
    evidence_bundle_id: null,
    acceptance_decision_id: null,
    delivery_id: null,
    failure: null,
    checkpoint: null,
    version: 1,
    created_at: now(),
    updated_at: now(),
  };
}
```

### 新增 `execution-run-store.mjs`

提供：`createRun`、`readRun`、`updateRun`、`appendAttempt`、`compareAndSetState`、`listRuns`。

```javascript
async function compareAndSetState({ runId, expectedState, nextState, patch = {} }) {
  return stateStore.transaction(async (state) => {
    const run = findRun(state, runId);
    if (run.state !== expectedState) {
      throw new StateConflictError({ runId, expectedState, actualState: run.state });
    }
    Object.assign(run, patch, {
      state: nextState,
      version: run.version + 1,
      updated_at: now(),
    });
    return structuredClone(run);
  });
}
```

CAS 是强制要求，防止两个 Worker 同时推进同一个 Run。

## 7. 收敛目录职责

最终职责：

- `execution-core/`：Intent、Plan、Run、状态机、事件、投影、恢复。
- `execution/`：Attempt、Provider Contract、Registry、选择、Failover、Checkpoint。
- `executions/`：先保留兼容 Facade，最终逐步废弃重复 Store/Interface。

## 8. 重构 `backend/src/execution/execution-orchestrator.mjs`

当前关键区域：

- 约第 10–20 行：构造函数。
- 约第 23–39 行：`claim`。
- 约第 41–183 行：`run`。
- 约第 49–83 行：`failCurrent`。
- 约第 116–131 行：Evidence 收集。
- 约第 145–164 行：`waiting_for_supervisor`。

重构后只负责 Provider Attempt，不决定 Run、Task、Goal、验收或集成。

```javascript
export function createExecutionAttemptOrchestrator({
  attemptStore,
  providerRegistry,
  failureClassifier,
  failoverPolicy,
  checkpointService,
}) {
  async function execute({ run, intent, planNode, context, workspace }) {
    let providerName = selectInitialProvider({ run, intent, planNode });
    let checkpoint = run.checkpoint || null;

    for (let n = 1; n <= intent.execution_policy.max_attempts; n += 1) {
      const attempt = await attemptStore.claim({
        runId: run.id,
        planNodeId: planNode.id,
        provider: providerName,
        attemptNumber: n,
        checkpoint,
      });

      try {
        const outcome = await executeSingleAttempt({
          attempt,
          provider: providerRegistry.require(providerName),
          context,
          workspace,
        });

        if (outcome.kind === "evidence_ready") {
          return { kind: "evidence_ready", attempt, raw_evidence: outcome.raw_evidence };
        }
        if (outcome.kind === "supervisor_required") {
          return {
            kind: "supervisor_required",
            attempt,
            checkpoint: outcome.checkpoint,
            reason: outcome.reason,
          };
        }
        throw new ProviderOutcomeError(outcome);
      } catch (error) {
        const failure = failureClassifier.classify(error);
        await attemptStore.fail(attempt.id, failure);
        const failover = failoverPolicy.decide({
          failure,
          currentProvider: providerName,
          attemptNumber: n,
          maxAttempts: intent.execution_policy.max_attempts,
        });
        if (!failover.allowed) return { kind: "failed", attempt, failure };
        checkpoint = await checkpointService.create({ attempt, failure, context });
        providerName = failover.next_provider;
      }
    }

    return { kind: "failed", failure: { code: "attempt_budget_exhausted" } };
  }

  return { execute };
}
```

## 9. Checkpoint 强制结构

修改：`backend/src/execution/execution-checkpoint.mjs`

```javascript
export function buildExecutionCheckpoint(input) {
  return {
    schema_version: 2,
    run_id: input.runId,
    attempt_id: input.attempt.id,
    provider: input.attempt.provider,
    provider_session: {
      control_session_id: input.controlSessionId || null,
      native_session_id: input.nativeSessionId || null,
      resume_token: input.resumeToken || null,
    },
    repository: {
      worktree_path: input.repository.worktree_path || null,
      branch: input.repository.branch || null,
      base_sha: input.repository.base_sha || null,
      head_sha: input.repository.head_sha || null,
      dirty_paths: input.repository.dirty_paths || [],
    },
    progress: {
      completed_steps: input.progress?.completed_steps || [],
      current_step: input.progress?.current_step || null,
      pending_steps: input.progress?.pending_steps || [],
    },
    evidence: {
      collected_items: input.acceptance?.completed_items || [],
      missing_items: input.acceptance?.missing_items || [],
    },
    failure: normalizeFailure(input.failure),
    recovery: {
      classification: input.recovery?.classification || "unknown",
      automatic_action: input.recovery?.automatic_action || null,
      supervisor_action: input.recovery?.supervisor_action || null,
      resumable: input.recovery?.resumable === true,
    },
    created_at: now(),
  };
}
```

Checkpoint 必须回答：为什么等待、缺什么、自动修过什么、Supervisor 应做什么、能否恢复。

## 10. 重构 `backend/src/executions/execution-runtime-service.mjs`

当前关键区域：

- 约第 31–43 行：依赖注入。
- 约第 52–153 行：`start`。
- 约第 163–190 行：`status`。
- 约第 199–243 行：`stop`。
- 约第 285–340 行：`collect`。

当前问题：先 Claim Task 后创建 Execution；创建记录太晚；Goal 被传为 null；Evidence blocker 被直接判定为 Execution failed。

改为兼容外壳：

```javascript
export function createExecutionRuntimeService({ executionRunService, legacyTaskAdapter }) {
  async function start(requestInput) {
    const request = normalizeExecutionRequest(requestInput);
    const result = await executionRunService.start(request);
    await legacyTaskAdapter.projectRun(result.run);
    return toLegacyStartResult(result);
  }

  async function status({ execution_id }) {
    return toLegacyExecutionStatus(await executionRunService.read(execution_id));
  }

  return {
    start,
    status,
    stop: executionRunService.requestStop,
    collect: executionRunService.collect,
    cancel: executionRunService.cancel,
  };
}
```

Evidence 有 blocker 不等同 Provider 失败，应进入 `evaluating -> waiting_for_repair`。

## 11. ExecutionRunService

新增：`backend/src/execution-core/execution-run-service.mjs`

核心顺序：先创建 Run，再做任何副作用。

```javascript
async function start(request) {
  const intent = request.intent || await intentStore.read(request.intent_id);
  let run = await runStore.createRun({
    intent_id: intent.id,
    goal_id: request.goal_id,
    task_id: request.task_id,
    workstream_id: request.workstream_id,
  });

  try {
    run = await transition(run, "created", "planning");
    const plan = await planCompiler.compile(intent);
    const workspace = await workspaceService.prepare({ run, intent, plan });
    const context = await contextService.build({ run, intent, plan, workspace });
    run = await runStore.updateRun(run.id, {
      plan_id: plan.id,
      workspace_ref: workspace?.id || null,
      context_ref: context.id,
    });
    run = await transition(run, "planning", "ready");
    return advanceRun(run.id);
  } catch (error) {
    return failRun(run.id, error);
  }
}

async function advanceRun(runId) {
  let run = await runStore.readRun(runId);
  const plan = await loadPlan(run.plan_id);

  for (const node of getRunnableNodes(plan)) {
    run = await transitionAny(run, ["ready", "running"], "running");
    const outcome = await attemptOrchestrator.execute({
      run,
      intent: await loadIntent(run.intent_id),
      planNode: node,
      context: await loadContext(run.context_ref),
      workspace: await loadWorkspace(run.workspace_ref),
    });

    if (outcome.kind === "failed") return handleAttemptFailure(run, node, outcome);
    if (outcome.kind === "supervisor_required") return pauseForSupervisor(run, outcome);

    const evidence = await evidenceService.normalizeAndPersist({
      run,
      node,
      rawEvidence: outcome.raw_evidence,
    });
    await markNodeEvidenceReady(plan.id, node.id, evidence.id);
  }

  if (!allNodesComplete(plan)) return advanceRun(run.id);
  return evaluateRun(run.id);
}
```

验收完成后：只读场景直接完成；有副作用场景进入 Delivery/Integration。

## 12. 修改 `backend/src/task-processing/task-provider-dispatcher.mjs`

当前关键位置：

- 约第 8–16 行：`requestedProvider`。
- 约第 18–35 行：`defaultProviders`。
- 约第 37–60 行：`persistUnavailableAttempt`。
- 约第 62–156 行：`dispatchTaskProvider`。

改成 Legacy Adapter：

```javascript
export async function dispatchTaskProvider(input = {}, deps = {}) {
  const intent = await deps.legacyTaskAdapter.taskToIntent({
    task: input.task,
    goal: input.goal,
  });

  const result = await deps.executionRunService.start({
    intent,
    task_id: input.task.id,
    goal_id: input.goal?.id || null,
    execution_policy: {
      preferred_provider: normalizeLegacyProvider(
        input.task.execution_policy?.provider ||
        input.task.metadata?.execution_provider ||
        input.task.metadata?.codex_execution_provider ||
        "auto"
      ),
      fallback_allowed: input.task.execution_policy?.fallback_allowed !== false,
    },
    context_ref: input.context?.context_ref || null,
  });

  return deps.legacyTaskAdapter.runResultToProviderDispatchResult(result);
}
```

该文件删除 Provider Registry、Provider 创建、选择、fallback、Checkpoint 和 Orchestrator 的直接逻辑。

## 13. Provider Contract

统一保留：`backend/src/execution/execution-provider-contract.mjs`

```javascript
export const EXECUTION_PROVIDER_METHODS = Object.freeze([
  "availability",
  "start",
  "resume",
  "observe",
  "interrupt",
  "collect",
  "dispose",
]);
```

`observe()` 只能返回：`starting`、`running`、`evidence_ready`、`supervisor_required`、`failed`。

Provider 禁止返回：`completed`、`waiting_for_review`、`waiting_for_integration` 等业务状态。

`collect()` 只返回原始证据：

```javascript
{
  provider_claims: [],
  artifacts: [],
  commands: [],
  session: {},
  repository_snapshot: {},
  raw_result: {},
}
```

## 14. 状态投影

新增：`backend/src/execution-core/execution-projection-service.mjs`

```javascript
async function project(run) {
  const projection = mapRunStateToTaskState(run);
  if (run.task_id && projection) {
    await taskTransitionService.projectState({
      task_id: run.task_id,
      execution_run_id: run.id,
      target_status: projection.status,
      reason: projection.reason,
      idempotency_key: `run:${run.id}:version:${run.version}`,
    });
  }
  if (run.goal_id) await goalLifecycleService.projectExecutionRun(run);
  if (run.workstream_id) await workstreamService.projectExecutionRun(run);
}
```

映射：

- created/planning/ready -> starting
- running -> running
- collecting/evaluating -> collecting
- waiting_for_repair -> waiting_for_repair
- waiting_for_review -> waiting_for_review
- waiting_for_integration -> waiting_for_integration
- completed -> completed
- failed -> failed
- cancelled -> cancelled

所有 Run 状态变更后必须调用 Projection；TUI、Exec、Worker 不再直接改 Task。

## 15. EvidenceBundle

新增：`backend/src/evidence/evidence-bundle-schema.mjs`

```javascript
export function createEvidenceBundle(input) {
  return {
    schema_version: 2,
    id: input.id || createId("evidence_bundle"),
    run_id: input.run_id,
    attempt_ids: input.attempt_ids || [],
    repository: {
      base_sha: null,
      head_sha: null,
      branch: null,
      worktree_path: null,
      dirty_before: [],
      dirty_after: [],
      changed_files: [],
      commit_sha: null,
      integrated_sha: null,
    },
    commands: [],
    tests: {
      executed: false,
      passed: null,
      total: null,
      passed_count: null,
      failed_count: null,
      skipped_count: null,
      coverage: null,
    },
    artifacts: [],
    document_validation: { executed: false, passed: null, checks: [] },
    readonly_proof: {
      required: false,
      before_sha: null,
      after_sha: null,
      mutation_detected: null,
    },
    provider_claims: [],
    verified_facts: [],
    rejected_claims: [],
    completeness: {
      required_items: [],
      present_items: [],
      missing_items: [],
    },
    created_at: now(),
  };
}
```

Provider 说“884 项测试通过”时，若没有命令、exit code、报告 Artifact，则必须进入 `rejected_claims`，不能成为事实。

## 16. Acceptance Profiles

修改：`backend/src/acceptance/contract-profiles.mjs`

现有 `code_change`、`docs_only` 等继续保留，新增：

### `test_only`

- 不要求 Commit。
- 不要求 Integration。
- 必须有测试命令、exit code、测试汇总、只读或声明生成物证据。

### `question`

- `mutation_scope: none`。
- 不要求 Commit/Integration。
- 必须有直接答案、来源证据、无副作用证明。

### `code_review`

- 必须有 review scope。
- 每个阻断问题必须含文件、位置、原因。
- 不得修改仓库。

### `planning`

- 必须有有序计划、目标文件/符号位置、每步验收标准。

## 17. AcceptanceDecision

新增：`backend/src/acceptance/acceptance-decision-schema.mjs`

状态只允许：

```text
accepted
repair_required
review_required
rejected
```

Evidence 缺失但可自动补齐时返回 `repair_required`，不能直接宣告 Provider failed。

## 18. 四类核心场景

### 代码修改

```text
classify -> context -> worktree -> analyze -> modify -> targeted tests
-> changed verification -> git evidence -> commit -> acceptance
-> integration -> post-integration verification -> complete
```

强制：改动相关、测试命令可验证、Commit 存在、工作树干净、需集成时已集成。

### 文档更新

```text
classify -> worktree -> read docs -> modify -> docs checks
-> diff -> commit -> acceptance -> complete
```

默认 `requires_integration: false`，但用户明确要求合并时由 Delivery Policy 处理。

### 测试

```text
classify -> snapshot before -> run tests -> collect exit codes/reports
-> snapshot after -> verify no unexpected mutation -> acceptance -> complete
```

不要求 Commit，必须记录 command、cwd、exit_code、duration、stdout/stderr/report refs。

### 问询

```text
classify -> readonly context -> retrieve files -> analyze
-> grounded answer -> no-mutation proof -> acceptance -> complete
```

禁止创建 worktree、获取写锁、Commit、Integration、调用副作用工具。

## 19. 1,310,720 Token 上下文预算

修改相关文件：

- `backend/src/context-index/context-budget-planner.mjs`
- `context-bundle-builder.mjs`
- `context-curator.mjs`
- `retriever.mjs`
- `context-contract/task-context-compiler.mjs`

131 万是整个 Run 的逻辑预算，不是一次 Prompt 全塞。

建议比例：

```javascript
{
  total_run_budget: 1_310_720,
  global_context: 2%,
  project_context: 8%,
  goal_context: 10%,
  plan_context: 5%,
  retrieved_code: 35%,
  retrieved_tests: 10%,
  recent_execution_history: 8%,
  evidence_context: 7%,
  provider_working_context: 10%,
  reserve: 5%,
}
```

每次 Provider 调用只传 immutable、project、retrieved、runtime、prior_results 五层。

必须生成 Context Manifest，记录代码版本、SHA、文件行区间、理由、token 估算、cache key。恢复时依据 Manifest 重建，不依赖长聊天全文。

## 20. 多 Agent DAG

复用并升级：

- `planning/plan-ir-schema.mjs`
- `planning/plan-ir-compiler.mjs`
- `orchestration/task-dag-service.mjs`
- `task-fanout-service.mjs`
- `task-join-service.mjs`
- `fanout-join-controller.mjs`

节点增加：`run_id`、`operation_kind`、`role`、`mutation_scope`、`concurrency_group`、`expected_evidence`、`acceptance_profile`。

推荐 DAG：architect -> parallel builders -> tester -> reviewer -> integrator。

只读节点可并行；写同一 worktree 的节点必须串行或使用独立 worktree；Join 只依赖结构化 Evidence。

## 21. Recovery Engine

修改：`backend/src/execution/execution-failure-classifier.mjs`

失败结构：

```javascript
{
  domain,
  code,
  repairability,
  retry_scope,
  recommended_action,
}
```

Domain：provider、session、workspace、repository、context、evidence、acceptance、integration、infrastructure、policy。

新增 `execution-recovery-service.mjs`，按 code 执行动作：

- native session 缺失 -> rebind session。
- result.json 缺失 -> 仅重收 Evidence。
- commit 缺失 -> deterministic commit repair。
- dirty worktree -> 分类后清理或保留。
- context stale -> 重建 Context。
- provider unavailable -> failover。
- integration conflict -> 创建 integration repair node。
- 未知失败 -> supervisor_required。

禁止所有失败统一 Retry。

## 22. result.json 强合同

新增：`backend/src/execution-core/execution-result-schema.mjs`

至少校验：run_id、attempt_id、outcome、changed_files、commands、commit_sha 格式、worktree_clean、blockers。

Provider 完成必须满足：Provider 产生合法结构化结果，或 Evidence Collector 从 Git/命令/文件重建合法结果；否则进入 evidence repair。

## 23. 测试目录

新增：

```text
backend/test/execution-core/
├── execution-intent-schema.test.mjs
├── execution-intent-classifier.test.mjs
├── execution-run-state-machine.test.mjs
├── execution-run-store.test.mjs
├── execution-run-service.test.mjs
├── execution-projection-service.test.mjs
├── execution-recovery-service.test.mjs
├── operation-profile-registry.test.mjs
└── legacy-task-adapter.test.mjs
```

关键测试：

1. Provider 失败后 Run 与 Task 同步终态。
2. TUI 不可用时同一 Run 内 fallback 到 Exec。
3. 无证据的 Provider 自述不能通过 Acceptance。
4. Question 不创建 worktree、不拿锁。
5. Docs 需要 Commit 但默认不要求 Integration。
6. Test-only 无 Commit 可完成。
7. CAS 阻止双 Worker 重复推进。
8. 系统重启后依据 Checkpoint 恢复。

## 24. Wave 顺序

### Wave 0：纯数据内核

新增 Intent、Run、Event、状态机、Legacy Adapter 与测试；不接生产入口。

### Wave 1：Provider Contract

统一 TUI/Exec 的 start/resume/observe/collect/dispose，Provider 不再输出 Task 状态。

### Wave 2：Run 接管执行

新增 RunStore、RunService、Projection；修改 dispatcher、runtime service、execution runner。

### Wave 3：Evidence 强制化

统一 EvidenceBundle、result.json、Claim 对账、Git/命令/Test 自动取证。

### Wave 4：场景 Profile

补全 test_only、question、code_review、planning，接入 ephemeral 路径。

### Wave 5：Recovery

分类恢复、局部修复、恢复预算、可行动 Checkpoint。

### Wave 6：多 Agent DAG

节点绑定 Run、独立 Attempt、并发冲突保护、Evidence Join。

### Wave 7：删除重复实现

确认无引用后逐步废弃 `executions/execution-store.mjs`、`execution-service.mjs`、`execution-provider-interface.mjs`。删除前执行 `rg` 全量引用检查。

## 25. 结束条件

以下 Canary 必须全部通过：

- 代码修改完整交付。
- TUI 不可用自动 fallback Exec。
- TUI 失败时 Task 不残留 running。
- 文档更新不因 Integration 假阻塞。
- 测试场景无 Commit 可完成。
- 问询零副作用。
- Evidence 缺失进入局部修复。
- Commit 缺失只做 commit repair。
- 虚构测试结果被拒绝。
- 多 Agent 按 DAG 推进。
- 重启可恢复。
- 重复调用幂等。
- 并发调用由 CAS 保护。
- 集成冲突进入 Integration Repair。
