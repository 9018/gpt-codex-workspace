# GPTWork 分阶段 Goal Relay Canary

## 产品目标
验证 GPTWork 是否严格按“总体方案 → 分阶段 /goal → 执行中普通纠偏 → ChatGPT 验收 → 必要时 repair plan + 下一 /goal → 直到完成”运行。

## Goal 01：执行第一阶段
在隔离 worktree 中创建 `docs/workflow-canary-result.md`，包含：
- `phase: 01`
- `goal_dispatch: /goal`
- `correction_mode: ordinary`
- `acceptance_owner: ChatGPT`

执行过程中，ChatGPT 将发送一次普通纠偏，要求增加 `correction_applied: true`，不得创建新 Goal。

## Goal 01 验收
- 任务由真实 Codex TUI `/goal` 启动；
- 普通纠偏写入同一 Goal/session；
- 结果文件包含全部五项字段；
- result.json、verification、commit、clean worktree 证据完整。

## 后续规则
- 若 Goal 01 验收通过：本 Canary 产品目标完成，不创建虚假 repair Goal。
- 若 Goal 01 验收失败：生成 `gptplan/workflow-canary-2026-07-18-repair.md`，再创建 Goal 02 修复剩余问题。
- Goal 02 仍失败时，继续生成带轮次的 repair plan，并创建 Goal 03，直到 ChatGPT 判定完成或发现不可自动修复阻塞。
