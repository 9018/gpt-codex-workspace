# Execution OS 重构方案包

基准：`main@1d818da`

目标：围绕 `方向.txt` 建立覆盖代码修改、文档更新、测试、问询、多 Agent、Codex TUI/Exec 切换、Evidence 驱动验收、自动恢复、自动集成与上下文索引的完整闭环。

## 文件说明

- `implementation-plan.md`：文件级、函数级重构方案与伪代码。
- `wave-task-templates.md`：可直接下发给低等级模型的 Wave 任务模板。
- `acceptance-matrix.md`：场景、状态、Evidence、失败恢复与端到端验收矩阵。

## 推荐实施顺序

1. Wave 0：建立 ExecutionIntent、ExecutionRun、Event、状态机与兼容适配器。
2. Wave 1：统一 Provider Contract。
3. Wave 2：ExecutionRun 接管 Provider 与 Task 状态投影。
4. Wave 3：统一 EvidenceBundle，强制 result.json。
5. Wave 4：补全 code/docs/test/question/review/planning 场景 Profile。
6. Wave 5：建立分类恢复引擎。
7. Wave 6：多 Agent DAG 接入 ExecutionRun。
8. Wave 7：删除旧的重复 Execution 路径。

每个 Wave 必须独立提交、独立测试、可回滚。禁止一次性推倒重写。