# 闭环验收矩阵

## 场景矩阵

| 场景 | mutation_scope | Worktree | 写锁 | Commit | Integration | 关键 Evidence |
|---|---:|---:|---:|---:|---:|---|
| code_change | repo | 是 | 是 | 必须 | 按合同 | diff、commands、tests、commit、clean tree、integration |
| docs_change | repo | 是 | 是 | 必须 | 默认否 | docs diff、docs check、commit |
| test_only | none | 默认否 | 否 | 否 | 否 | command、exit code、test report、no unexpected mutation |
| question | none | 否 | 否 | 否 | 否 | answer、source refs、verified facts、no mutation |
| code_review | none | 否 | 否 | 否 | 否 | scope、file/line finding、severity、rationale |
| planning | none | 否 | 否 | 否 | 否 | ordered plan、target files/symbols、acceptance criteria |

## 状态一致性矩阵

| Provider/Attempt 状态 | ExecutionRun 状态 | Task 投影 |
|---|---|---|
| starting | running/ready | starting |
| running | running | running |
| evidence_ready | collecting/evaluating | collecting |
| supervisor_required | waiting_for_repair 或 waiting_for_review | 对应等待状态 |
| failed 且可恢复 | waiting_for_repair | waiting_for_repair |
| failed 且不可恢复 | failed | failed |
| Evidence accepted | completed 或 waiting_for_integration | completed/等待集成 |
| cancelled | cancelled | cancelled |

强制不变量：Provider 已终止时，Task 不得继续保持 running。

## Evidence 完整性

### code_change

- changed_files 非空且与任务相关。
- git diff 可读取。
- 测试/校验命令包含 exit_code。
- commit_sha 可由 Git 验证。
- worktree_clean 为真实检测结果。
- 需要 Integration 时 integrated_sha 存在。
- Provider 自述不能替代上述字段。

### docs_change

- 改动文件全部属于允许文档范围。
- 至少一个 docs_check、链接检查、lint、结构检查或目标文本检查。
- Commit 存在。
- 默认不因 integration pipeline 阻塞关闭。

### test_only

- 至少一个实际测试命令。
- 每个命令有 cwd、exit_code、duration 和输出引用。
- 测试报告与当前 HEAD 对应。
- 前后仓库快照证明没有意外修改。

### question

- 回答直接覆盖用户问题。
- 关键判断引用文件、符号、命令结果或结构化状态。
- 不创建 worktree、不获取写锁、不修改文件。

## 自动恢复矩阵

| failure code | 自动动作 | 重试范围 | 不能做的事 |
|---|---|---|---|
| provider_unavailable | 选择允许的 fallback provider | 新 Attempt | 不能把 Run 重新创建 |
| native_session_binding_missing | 重绑/重新解析 session | 同 Provider | 不能伪造 session id |
| result_json_missing | 重收 Evidence/重建结果 | evidence-only | 不能重跑完整代码修改 |
| commit_missing | deterministic commit repair | delivery-only | 不能宣称已提交 |
| worktree_dirty_unexpected | 分类 dirty paths 后清理/保留 | workspace-only | 不能无条件 reset 用户改动 |
| context_stale | 重建 Manifest/Context | context-only | 不能沿用过期 SHA |
| test_evidence_missing | 重跑指定验证命令 | verification-only | 不能接受自然语言结果 |
| integration_conflict | 新建 integration repair node | integration-only | 不能笼统标记代码执行失败 |
| attempt_budget_exhausted | supervisor_required checkpoint | 无 | 不能无限 Retry |

## 多 Agent 验收

- Architect 输出设计 Artifact，不直接修改代码。
- Builder 只提交自己分片允许的文件。
- Tester 使用 Builder 的 commit/changed files，但独立运行测试。
- Reviewer 不能把 Builder 自述当事实。
- Integrator 只接受已通过 Acceptance 的前置节点。
- 两个修改同一 worktree 的 Builder 不得无锁并行。
- Join 依据结构化节点状态和 Evidence，而不是日志关键词。

## 上下文验收

- 1,310,720 tokens 是 Run 总预算，不是单 Prompt 强制填满。
- 每个节点生成 Context Manifest。
- Manifest 包含 base/head SHA、code map revision、文件行区间、hash、纳入理由和 token 估算。
- 恢复执行时可按 Manifest 重建。
- 无关历史、重复日志和已过期文件不能进入 must_read。

## 端到端 Canary

1. 修改一处代码，完成测试、Commit、Integration、验收和状态投影。
2. 强制 TUI 不可用，同一 Run 自动建立 Exec Attempt。
3. 强制 TUI 进程退出，Task 不残留 running。
4. 仅修改文档，完成 Commit 和文档检查，不出现假 waiting_for_integration。
5. 只运行测试，无 Commit 也能完成。
6. 执行问询，不产生工作树、锁、Commit 或文件变更。
7. 删除 result.json，系统只触发 Evidence Repair。
8. 删除 Commit Evidence，系统只触发 Commit Repair。
9. Provider 输出虚构“全部测试通过”，Acceptance 拒绝。
10. Builder/Tester/Reviewer/Integrator 按 DAG 自动推进。
11. 服务重启后从 Run + Attempt + Checkpoint 恢复。
12. 重复 start/advance 调用保持幂等。
13. 两 Worker 竞争同一 Run 时 CAS 只允许一个成功。
14. Integration 冲突进入专门 Repair Node。

全部 Canary 通过后，才可认定 `方向.txt` 的完整闭环达到可产品化基线。