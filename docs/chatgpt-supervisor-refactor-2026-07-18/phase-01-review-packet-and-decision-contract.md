# Phase 01：Review Packet 与 ChatGPT Decision 合同

## 1. 目的

让 ChatGPT 判断“方向是否偏离”，但不能让 ChatGPT 自己从零搜索整个运行现场。WorkMCP 必须构建有 revision、可复现、受限且足够完整的审查包。

## 2. Review Revision

新增：`backend/src/supervisor-review/supervisor-review-revision.mjs`

```js
import { createHash } from "node:crypto";

export function buildReviewRevision({
  run,
  checkpoint,
  repository,
  contextManifest,
  supervisorPlan,
}) {
  const payload = {
    run_id: run.id,
    run_version: run.version,
    checkpoint_id: checkpoint?.id || null,
    checkpoint_digest: checkpoint?.digest || null,
    base_sha: repository.base_sha || null,
    head_sha: repository.head_sha || null,
    diff_digest: repository.diff_digest || null,
    dirty_paths: [...(repository.dirty_paths || [])].sort(),
    context_digest: contextManifest?.digest || null,
    plan_revision: supervisorPlan?.version || null,
    acceptance_contract_digest:
      run.acceptance_contract_digest || null,
  };

  return {
    ...payload,
    id: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}
```

规则：

- 任意关键事实变化都会产生新 revision。
- 定时任务重复调用但 revision 未变时，不重复创建 review。
- correction 发送后必须等待 progress/diff/checkpoint 变化，才允许新一轮语义审查。

## 3. Review Packet Schema

新增：`supervisor-review-packet-schema.mjs`

```js
export function createSupervisorReviewPacket(input) {
  if (!input.run?.id) throw new Error("run.id is required");
  if (!input.revision?.id) throw new Error("revision.id is required");

  return {
    schema_version: 1,
    id: `review_packet_${input.revision.id.slice(0, 20)}`,
    revision: input.revision,

    objective: {
      goal_text: input.goalText,
      task_text: input.taskText,
      desired_outcome: input.desiredOutcome,
      non_goals: input.nonGoals || [],
    },

    architecture_baseline: {
      principles: input.principles || [],
      prohibited_patterns: input.prohibitedPatterns || [],
      required_flow: input.requiredFlow || [],
      design_docs: input.designDocs || [],
    },

    execution: {
      run_id: input.run.id,
      run_state: input.run.state,
      controller_owner: input.run.supervision?.controller_owner,
      current_plan_node: input.currentPlanNode || null,
      correction_cycles: input.run.supervision?.correction_cycles || 0,
      prior_decisions: input.priorDecisions || [],
    },

    repository: {
      worktree_path: input.repository.worktree_path,
      base_sha: input.repository.base_sha,
      head_sha: input.repository.head_sha,
      changed_files: input.repository.changed_files || [],
      diff_summary: input.repository.diff_summary || "",
      focused_diff: input.repository.focused_diff || "",
      new_symbols: input.repository.new_symbols || [],
      deleted_symbols: input.repository.deleted_symbols || [],
    },

    verification: {
      commands: input.commands || [],
      tests: input.tests || [],
      blockers: input.blockers || [],
      evidence_gaps: input.evidenceGaps || [],
    },

    tui: {
      session_id: input.session?.session_id || null,
      native_session_id: input.session?.native_session_id || null,
      status: input.session?.status || null,
      progress: input.progress || null,
      recent_log_excerpt: input.recentLogExcerpt || "",
    },

    review_questions: [
      "实现是否仍沿着既定产品与架构方向推进？",
      "是否新增了重复状态、重复 Store、旁路执行链或兼容性主权？",
      "是否通过测试但绕过 Canonical Acceptance/Progression？",
      "是否只修复症状而未解决根因？",
      "继续当前方向的长期产品化代价是什么？",
    ],

    limits: {
      max_correction_scope_files: input.maxCorrectionScopeFiles || 20,
      allowed_actions: input.allowedActions || [
        "continue_codex",
        "send_correction",
        "pause_codex",
        "chatgpt_takeover",
        "wait",
      ],
    },

    created_at: new Date().toISOString(),
  };
}
```

## 4. 架构基线来源

不要每轮把所有历史对话塞入 Prompt。基线按优先级构建：

```text
SupervisorPlan.architecture_principles
 -> Goal acceptance / design spec
 -> 当前阶段实施文档
 -> project.md
 -> bounded recent decisions
```

必须包含当前项目已经确定的原则：

- ExecutionRun 是唯一长期业务运行对象。
- Native Codex TUI 是主要执行界面。
- 同一 worktree 接管和交还。
- Canonical Acceptance 是终态事实源。
- 不新增 SupervisorRun。
- Provider 不决定 Task/Goal 业务终态。
- 不允许 default exec fallback 改写产品定位。

## 5. Packet Builder

新增：`supervisor-review-packet-builder.mjs`

```js
export function createSupervisorReviewPacketBuilder(deps) {
  async function build({ runId }) {
    const run = await deps.runStore.readRun(runId);
    const [checkpoint, plan, repo, progress, session, history] =
      await Promise.all([
        deps.checkpointReader.latest(runId),
        deps.planReader.readForRun(run),
        deps.repositoryEvidence.collect(run),
        deps.tuiProgressReader.read(run),
        deps.tuiSessionReader.read(run),
        deps.decisionStore.listByRun(runId, 10),
      ]);

    const revision = buildReviewRevision({
      run,
      checkpoint,
      repository: repo,
      contextManifest: await deps.contextReader.read(run.context_ref),
      supervisorPlan: plan,
    });

    return createSupervisorReviewPacket({
      run,
      revision,
      repository: repo,
      progress,
      session,
      priorDecisions: history,
      ...await deps.objectiveReader.read(run),
      ...await deps.architectureBaselineReader.read(run, plan),
    });
  }

  return { build };
}
```

## 6. ChatGPT Decision Schema

新增：`supervisor-decision-schema.mjs`

```js
export const DECISION_ACTIONS = Object.freeze([
  "continue_codex",
  "send_correction",
  "pause_codex",
  "chatgpt_takeover",
  "wait",
  "evaluate_terminal",
]);

export function normalizeSupervisorDecision(input) {
  if (!input.review_revision_id) {
    throw new Error("review_revision_id is required");
  }
  if (!DECISION_ACTIONS.includes(input.action)) {
    throw new Error(`invalid action: ${input.action}`);
  }

  return {
    schema_version: 1,
    id: input.id || crypto.randomUUID(),
    run_id: input.run_id,
    review_revision_id: input.review_revision_id,
    verdict: input.verdict, // aligned | minor_drift | major_drift | blocked | terminal
    action: input.action,
    confidence: input.confidence || "medium",
    reason_codes: input.reason_codes || [],
    analysis_summary: input.analysis_summary || "",

    correction: input.action === "send_correction" ? {
      objective: input.correction?.objective,
      observed_drift: input.correction?.observed_drift || [],
      required_changes: input.correction?.required_changes || [],
      forbidden_changes: input.correction?.forbidden_changes || [],
      allowed_files: input.correction?.allowed_files || [],
      required_commands: input.correction?.required_commands || [],
      completion_evidence: input.correction?.completion_evidence || [],
    } : null,

    takeover: input.action === "chatgpt_takeover" ? {
      reason: input.takeover?.reason,
      expected_scope: input.takeover?.expected_scope || [],
      return_conditions: input.takeover?.return_conditions || [],
    } : null,

    decided_by: "chatgpt",
    decided_at: new Date().toISOString(),
  };
}
```

## 7. Correction 文本生成

`checkpoint-correction-builder` 不再自己猜缺陷，只负责渲染 Decision：

```js
export function renderCorrection(decision) {
  const c = decision.correction;
  return [
    `架构纠偏目标：${c.objective}`,
    "",
    "发现的方向偏离：",
    ...c.observed_drift.map((x) => `- ${x}`),
    "",
    "必须完成：",
    ...c.required_changes.map((x) => `- ${x}`),
    "",
    "禁止：",
    ...c.forbidden_changes.map((x) => `- ${x}`),
    "",
    `允许修改文件：${c.allowed_files.join(", ") || "仅限完成目标所需最小范围"}`,
    "",
    "完成前必须运行：",
    ...c.required_commands.map((x) => `- ${x}`),
    "",
    "不要创建新 Goal、Task、worktree 或第二套状态模型。继续当前 session。",
  ].join("\n");
}
```

## 8. Prompt 合同

ChatGPT 定时任务收到 Packet 后只应返回 JSON Decision，不直接调用 TUI send。推荐系统指令：

```text
你是该项目的 Chief Architect。判断实现是否偏离 architecture_baseline。
测试通过不等于方向正确。重点识别重复状态主权、旁路执行链、可选 canonical gate、
为了兼容保留第二套实现、修症状不修根因等问题。
只能输出 SupervisorDecision JSON。不要执行动作。
```

## 9. Phase 01 测试

- 相同事实产生相同 revision id。
- diff、HEAD、plan revision 任一变化都会改变 revision。
- Packet 不包含 secret/env 值。
- Packet 超预算时优先保留 architecture baseline、focused diff、new symbols。
- Decision 缺 revision/action 时拒绝。
- `continue_codex` 不允许携带 takeover。
- `send_correction` 必须有 objective 和至少一个 required change。
- 旧 revision 的 Decision 在提交时被标记 superseded，不能执行。
