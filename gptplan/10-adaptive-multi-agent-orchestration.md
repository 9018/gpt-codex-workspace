# 10 自适应多 Agent 协同方案

## 目标

从固定角色串行链升级为“确定性控制层 + 动态 Agent 团队”，简单任务少调用，复杂任务真并行。

## 主要文件

### 新增

- `backend/src/orchestration/pipeline-profile-schema.mjs`
- `backend/src/orchestration/pipeline-selector.mjs`
- `backend/src/orchestration/dynamic-team-planner.mjs`
- `backend/src/orchestration/fanout-join-controller.mjs`
- `backend/src/orchestration/role-independence-policy.mjs`
- `backend/src/orchestration/pipeline-escalation-policy.mjs`
- `backend/src/orchestration/agent-value-telemetry.mjs`
- `backend/src/orchestration/artifact-provenance-validator.mjs`

### 修改

- `backend/src/pipeline-orchestration.mjs`
- `backend/src/subagent-policy.mjs`
- `backend/src/agent-artifact-contract.mjs`
- `backend/src/agent-run-service.mjs`
- `backend/src/workstream/*`
- `backend/src/task-context-*`
- `backend/src/context-index/context-bundle-builder.mjs`

## Pipeline Profile

```js
{
  schema_version: 1,
  selected_profile,
  risk_level,
  strategy,
  roles,
  shards,
  dependencies,
  join_policy,
  escalation_rules,
  reason_codes
}
```

## 默认档位

```text
readonly: deterministic verifier
low: builder → deterministic verifier
medium: planner → builder → verifier → reviewer
high: dynamic fan-out builders + test designer + independent reviewer
```

integrator/finalizer 默认确定性执行，仅冲突或语义不确定时启动 Agent。

## 实施任务

1. 所有任务创建时强制生成 pipeline profile，禁止缺字段即 legacy。
2. legacy 由 schema version 和 cutoff 明确识别。
3. selector 使用文件范围、风险、部署、跨 repo、历史失败等事实。
4. dynamic planner 输出结构化 DAG，不直接创建 Agent Run。
5. controller 将 DAG 转为可持久化 workstream nodes。
6. 支持多个 builder 对不同 shard 并行工作。
7. 支持 test designer 独立于 builder。
8. reviewer 不读取 builder 自我结论，只读 diff、contract、test evidence。
9. artifact 必须包含：
   - producer role。
   - attempt ID。
   - input digest。
   - repo base commit。
   - task revision。
   - acceptance contract digest。
10. 任意输入 revision 变化，未执行或未消费 artifact 自动 supersede。
11. fan-in 前做 artifact provenance 和冲突检查。
12. builder 发现风险上升时生成 pipeline escalation command。
13. 记录每个角色：
   - latency。
   - token/cost。
   - finding count。
   - prevented failure。
   - repair contribution。
14. 定期基于数据调整默认 profile，但配置变更必须版本化。

## 并行冲突控制

- 每个 shard 独立 worktree 或明确文件 ownership。
- join 前先执行 deterministic merge simulation。
- 冲突进入 integration command，不由两个 builder 相互覆盖。
- 同一文件默认不能由两个并行 builder 修改，除非使用竞争实现模式。

## 验收命令

```bash
cd backend
node --test test/pipeline-orchestration.test.mjs
node --test test/subagent-policy-pipeline.test.mjs
node --test test/cross-cutting-pipeline-fixes.test.mjs
node --test test/workstream-*.test.mjs
node --test test/agent-artifact-contract.test.mjs
npm run check:syntax
npm run check:imports
```

## 完成标准

- 简单任务不再默认跑全角色。
- 复杂任务可自动 fan-out/join。
- verifier/reviewer 保持输入独立。
- pipeline 缺失对新任务是故障，不是 legacy 旁路。
