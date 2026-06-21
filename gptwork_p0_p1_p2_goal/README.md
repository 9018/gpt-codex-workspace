# GPTWork P0/P1/P2 Goal Bundle

这个 zip 是给另一个 agent 执行 GPTWork 产品化改造用的 goal 包。

## 文件说明

- `goal.md`：总目标。
- `context_summary.md`：当前代码分析上下文。
- `task.md`：可作为任务入口的 markdown。
- `payload.json`：机器可读 goal payload。
- `tasks/P0.md`：第一优先级任务。
- `tasks/P1.md`：第二优先级任务。
- `tasks/P2.md`：第三优先级任务。
- `acceptance_criteria.md`：总体验收。
- `implementation_notes.md`：建议实现顺序和建议改动文件。
- `.gptwork/goal-inbox/gptwork-p0-p2-productization-task.md`：适配 GPTWork goal-inbox/dispatch 风格的任务文件。

## 推荐给 agent 的入口

让 agent 先读 `task.md`，再读 `payload.json`，然后按 P0/P1/P2 顺序执行。
