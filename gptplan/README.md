# GPTWork 全自动 TUI、快速分析与全链路修复任务包

本任务包只包含实施方案，不包含代码改动。

## 总目标

将现有系统收敛为以下产品形态：

- `codex exec` 与 `codex tui` 都是无人值守的全自动执行后端。
- TUI 能自动启动、自动识别界面状态、自动输入、自动处理确认与错误提示、自动判断完成、自动采集证据、自动验收、自动修复、自动恢复和自动推进。
- Evidence 只能生成一个经过校验的 canonical decision。
- 所有自动动作都必须通过持久化、幂等、可恢复的 progression command 执行。
- 项目、worktree、`CODEX_HOME` 和原生 Codex session 具有唯一、可移植的路径语义。
- ChatGPT 首次分析时只加载最小工具与最小项目上下文，按需扩展，避免全量 schema 和全仓扫描。
- 核心 God File 按职责拆分，但先建立行为锁定测试，避免“边拆边改”造成链路回归。
- 多 Agent 从固定角色串行升级为按风险和任务结构动态编排。
- 服务重启、重复事件、TUI 断连、结果缺失、集成写回失败等异常都能自动收敛。

## 执行顺序

| 波次 | 方案 | 依赖 | 可并行关系 |
|---|---|---|---|
| 0 | 01 canonical decision | 无 | 必须最先 |
| 0 | 02 progression command | 01 | 与 03 后半段可并行 |
| 0 | 03 PathContext/CODEX_HOME/session | 无 | 可与 01 并行 |
| 1 | 04 TUI 无人值守自动驾驶 | 03 | 核心目标 |
| 1 | 05 exec/TUI ExecutionProvider 统一 | 01、03、04 | 不能早于 04 |
| 1 | 06 分析速度与延迟工具发现 | 无 | 可独立并行 |
| 2 | 07 task-general-processor 拆分 | 01、05 | 行为保持型重构 |
| 2 | 08 task-final-writeback 拆分 | 01、02 | 行为保持型重构 |
| 2 | 09 工具组、队列、巡检、retention 拆分 | 02、06 | 可拆成多个 Agent 并行 |
| 3 | 10 自适应多 Agent 编排 | 01、02、05 | 建议在闭环稳定后 |
| 3 | 11 全链路故障注入与发布门禁 | 01–10 | 最终收口 |
| 3 | 12 迁移、兼容删除和运行指标 | 01–11 | 最后执行 |

## 每个方案的执行纪律

1. 使用独立 Git worktree 和独立分支。
2. 开始前记录基线测试结果。
3. 每个任务先写失败测试，再实现最小代码。
4. 一个提交只完成一个可独立验收的行为。
5. 禁止在重构提交中顺手改变业务语义。
6. 每个方案结束时必须运行方案指定的定向测试、`check:syntax`、`check:imports`。
7. 只有最终收口方案运行完整 `npm test` 和发布门禁。
8. 对状态、路径、session、TUI 输入输出协议的改动必须包含 schema/version 迁移。
9. TUI 正常路径不得落入 `waiting_for_operator`、`waiting_for_input` 或人工接管；只能在不可自动解决且预算耗尽时进入明确的 terminal failure/review。
10. 所有自动输入必须由规则、状态机或结构化 Agent 决策生成，禁止依赖人工盯屏。

## 统一验收定义

一个任务只有同时满足以下条件才允许完成：

```text
provider terminal
AND evidence complete
AND verification passed
AND acceptance passed
AND integration satisfied when required
AND canonical decision consistent
AND progression effects applied
AND task/goal/queue/workstream projections reconciled
```

任何一项不满足，均不得写入 `completed`。
