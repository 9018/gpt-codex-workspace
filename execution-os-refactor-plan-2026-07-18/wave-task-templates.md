# Wave 任务模板（低等级模型可直接执行）

## 通用约束

每次只执行一个小任务。不得扩大修改范围。不得顺手重构无关代码。必须运行指定测试并提交真实 Evidence。

完成结果必须包含：

```json
{
  "schema_version": 2,
  "run_id": "真实 run id",
  "attempt_id": "真实 attempt id",
  "outcome": "succeeded|failed|partial",
  "summary": "实际完成内容",
  "changed_files": [],
  "commands": [
    { "command": "实际命令", "exit_code": 0 }
  ],
  "commit_sha": "真实 SHA 或 null",
  "worktree_clean": true,
  "blockers": [],
  "followup_findings": []
}
```

禁止填写 `TBD`、`actual-sha`、`应该通过`、`预计正常`。

---

## Wave 0.1：ExecutionIntent Schema

允许修改：

- `backend/src/execution-core/execution-intent-schema.mjs`
- `backend/test/execution-core/execution-intent-schema.test.mjs`

要求：

1. 定义 operation kinds 与 mutation scopes。
2. 实现 `normalizeExecutionIntent`。
3. 默认上下文上限为 `1_310_720`。
4. task_id、goal_id、workstream_id 可为空。
5. 不得选择 Provider，不得创建 worktree，不得修改 Task。

测试：缺 request_text 抛错；默认值正确；显式策略保留；输入对象不被修改。

---

## Wave 0.2：ExecutionRun Schema 与状态机

允许修改：

- `execution-run-schema.mjs`
- `execution-state-machine.mjs`
- 对应测试

要求：

1. 支持 created/planning/ready/running/collecting/evaluating/waiting_for_repair/waiting_for_review/waiting_for_integration/completed/failed/cancelled。
2. 定义允许迁移表。
3. terminal 状态不可回到 active。
4. Evidence-ready 不作为业务终态。

---

## Wave 0.3：ExecutionRun Store CAS

允许修改：

- `execution-run-store.mjs`
- 对应测试

要求：create/read/update/appendAttempt/compareAndSetState/list；版本号每次更新加一；错误 expectedState 必须抛 StateConflictError。

---

## Wave 1.1：统一 Provider Observation

允许修改：

- `backend/src/execution/execution-provider-contract.mjs`
- `backend/src/execution/providers/codex-exec-provider.mjs`
- `backend/src/execution/providers/codex-tui-provider.mjs`
- 对应测试

要求：

1. observation.state 只允许 starting/running/evidence_ready/supervisor_required/failed。
2. 禁止 completed/waiting_for_review/waiting_for_integration。
3. TUI 与 Exec 都经过同一 normalizer。
4. 保持旧调用兼容。

---

## Wave 1.2：统一 Provider Session 字段

要求 start/resume 返回 provider_run_id、control_session_id、native_session_id、resume_token、started_at；缺 native session 时必须记录结构化失败，不能静默忽略。

---

## Wave 2.1：Execution Projection

允许修改：

- `execution-projection-service.mjs`
- Task transition 适配测试

要求：Run 状态幂等投影到 Task；idempotency key 使用 run id + version；TUI/Exec 不得直接改 Task。

---

## Wave 2.2：Task Provider Dispatcher 适配

允许修改：

- `backend/src/task-processing/task-provider-dispatcher.mjs`
- `legacy-task-adapter.mjs`
- 对应测试

要求：dispatcher 只把旧 Task 转成 Intent/Request 并调用 ExecutionRunService；移除本文件的 Registry、Provider 创建、选择、fallback、Checkpoint、Orchestrator 逻辑。

---

## Wave 2.3：Execution Runtime Facade

允许修改：

- `backend/src/executions/execution-runtime-service.mjs`
- 对应测试

要求：旧 API 保留，但逻辑委托 ExecutionRunService；任何副作用前先创建 Run；不得把 Evidence blocker 直接判成 Provider failed。

---

## Wave 3.1：EvidenceBundle Schema

允许修改：

- `backend/src/evidence/evidence-bundle-schema.mjs`
- `backend/src/evidence/evidence-normalizer.mjs`
- 对应测试

要求：包含 repository、commands、tests、artifacts、document_validation、readonly_proof、provider_claims、verified_facts、rejected_claims、completeness。

---

## Wave 3.2：Provider Claim 对账

要求：没有命令 exit code 或 Artifact 的“测试通过”自述进入 rejected_claims；不得进入 verified_facts；Acceptance 不得使用未验证 Claim。

---

## Wave 3.3：result.json 强合同

允许修改：

- `execution-result-schema.mjs`
- Codex result parser/normalizer 相关文件
- 对应测试

要求：校验 run_id、attempt_id、outcome、changed_files、commands、commit_sha、worktree_clean、blockers；缺失时进入 evidence repair。

---

## Wave 4.1：test_only Profile

修改 `acceptance/contract-profiles.mjs`。不要求 Commit/Integration；要求测试命令、exit code、测试汇总、只读或声明生成物证据。

---

## Wave 4.2：question Profile

要求：不创建 worktree、不拿写锁、不提交、不集成；必须有 answer、sources/verified facts、no-mutation proof。

---

## Wave 4.3：code_review 与 planning Profile

Review 阻断项必须含位置和理由；Planning 必须含有序步骤、文件/符号位置和每步验收。

---

## Wave 5.1：Failure Taxonomy

修改 `execution-failure-classifier.mjs`。输出 domain、code、repairability、retry_scope、recommended_action。禁止仅输出 execution_failed。

---

## Wave 5.2：Recovery Registry

新增 `execution-recovery-service.mjs` 与 `recovery-action-registry.mjs`。实现 session rebind、evidence recollect、commit repair、dirty worktree repair、context rebuild、provider failover、integration repair。

---

## Wave 6.1：Execution Plan DAG 节点扩展

修改 Plan IR 与 orchestration 文件。节点增加 run_id、role、mutation_scope、concurrency_group、expected_evidence、acceptance_profile。

---

## Wave 6.2：并发与 Join

只读节点允许并行；同 worktree 写节点禁止并行；Tester 等待 Builder；Reviewer 独立验证；Join 只读 Evidence，不读 Builder 自述。

---

## Wave 7：清理重复实现

删除前必须运行：

```bash
rg 'executionStore' backend/src backend/test
rg 'createExecutionRuntimeService' backend/src backend/test
rg 'execution-provider-interface' backend/src backend/test
```

只有所有生产调用已迁移、旧测试已有替代时才允许删除。