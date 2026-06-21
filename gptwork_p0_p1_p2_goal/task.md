---
kind: gptwork-task
status: ready
assignee: codex
mode: builder
payload: payload.json
---

# GPTWork P0/P1/P2 Productization Task

请读取本 zip 中的：

1. `goal.md`
2. `context_summary.md`
3. `tasks/P0.md`
4. `tasks/P1.md`
5. `tasks/P2.md`
6. `acceptance_criteria.md`
7. `implementation_notes.md`
8. `payload.json`

然后按优先级执行。

## 执行顺序

1. 先完成 P0。
2. P0 可验证后，再做 P1。
3. P1 稳定后，再做 P2。
4. 每完成一个阶段，更新实现摘要、变更文件、测试结果、后续建议。

## 结果要求

最终写出：

- 实现摘要
- 变更文件列表
- 测试/检查结果
- 未完成项
- 后续建议

如果接入 GPTWork，请按 result.json contract 写结构化结果。
