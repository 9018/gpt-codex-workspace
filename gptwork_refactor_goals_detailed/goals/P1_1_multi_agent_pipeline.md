# P1-1 Goal：多 agent pipeline 最小执行闭环

## 目标

把 subagent 从“Codex 自报字段”升级为最小可用 pipeline。MVP 可以仍由同一个 Codex CLI 分阶段执行，但必须有真实 agent run 状态记录和阶段输出。

## 涉及文件

```text
backend/src/agent-service.mjs 或现有 agent 相关文件
backend/src/agent-tools.mjs 或 tool-groups 中 agent 工具
backend/src/codex-autonomy-validator.mjs
backend/src/task-general-processor.mjs
backend/src/task-final-writeback.mjs
```

## 角色集合

必须统一：

```text
planner
architect
implementer
tester
reviewer
finalizer
repairer
escalation_judge
```

未知 role 不能默默归一成 implementer。

## 默认 pipeline

普通 builder task：

```text
planner -> implementer -> tester -> reviewer -> finalizer
```

失败后：

```text
repairer -> tester -> reviewer -> finalizer
```

## 每个 agent run 字段

```json
{
  "agent_run_id": "agent_<id>",
  "task_id": "task_<id>",
  "goal_id": "goal_<id>",
  "role": "tester",
  "status": "queued|running|completed|failed|skipped",
  "input_summary": "...",
  "output_summary": "...",
  "started_at": "...",
  "completed_at": "..."
}
```

## 验收标准

- [ ] 普通 task 至少创建 planner/implementer/tester/reviewer/finalizer agent runs。
- [ ] 每个 agent run 有状态和时间。
- [ ] final result.json 中的 subagents 来自 agent run 记录，而不只是凭空生成。
- [ ] tester/reviewer 失败会影响最终 completed 判定。
- [ ] repair 过程使用 repairer 角色。
