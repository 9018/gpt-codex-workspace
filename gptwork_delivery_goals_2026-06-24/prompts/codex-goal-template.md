# Codex Goal Template

你正在执行 GPTWork 交付级多目标包中的一个 goal。

## 必须遵守

1. 先读取 goal 文档全文。
2. 不要只改文档；除非 goal 明确是文档 goal，否则必须落实到代码和测试。
3. 每次修改必须保持小步、可回滚、可审查。
4. 使用 task worktree 执行，不要污染 canonical repo。
5. 任何 completed 状态必须有真实验收证据。
6. 如果发现目标过大，拆分 next_tasks，但当前 goal 必须尽最大努力完成 P0 主链路。

## 输出 result.json

必须包含：status、summary、changed_files、tests、commit、warnings、acceptance_findings、reviewer_decision、verification、subagents_used、subagents、next_tasks、repair_proposal。
