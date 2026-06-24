# GPTWork 交付级多 Goal 修改包

生成日期：2026-06-24

这个 ZIP 是一组可以直接拆分下发给 Codex/多 agent 的修改目标（goals）。目标是把当前 `9018/gpt-codex-workspace` 从“已有 worktree/Zvec/验收雏形”推进到可交付用户侧的多任务自动执行系统。

## 最终交付形态

1. 每个用户任务生成独立 goal、上下文 bundle、执行分支和 Git worktree。
2. 长 GPTChat 对话通过 Zvec/混合检索生成 `context.bundle.md`，Codex 默认读取 bundle，不吞完整 transcript。
3. Worker 并发执行多个任务，同一目标分支的 merge/push/integration 串行。
4. 每个任务完成后经过通用自动验收；验收失败自动生成 repair task 并重试。
5. 只有通过验收、集成、清理/保留策略的任务才标记 completed。
6. 部署、ChatGPT MCP 接入、Codex 接入、任务下发、执行、验收、结束任务，有完整 E2E 验收脚本和用户侧文档。

## 推荐执行顺序

1. GOAL-00：总编排与交付契约
2. GOAL-01：真实 Git worktree lifecycle
3. GOAL-02：无副作用队列调度
4. GOAL-03：执行路径/result contract
5. GOAL-04：Zvec 长上下文管理
6. GOAL-05：通用自动验收 agent
7. GOAL-06：自动 repair loop
8. GOAL-07：integration queue / merge lock
9. GOAL-08：自愈与可观测性
10. GOAL-09：用户侧交付 E2E
11. GOAL-10：发布硬化测试矩阵

## 包内文件

- `goals/*.md`：每个可执行修改目标。
- `configs/goal-dependency-graph.json`：目标依赖图。
- `configs/acceptance-profile.v1.json`：通用验收条件。
- `configs/encoded-goal-payloads.jsonl`：可转成 `create_encoded_goal` payload 的结构化任务。
- `prompts/codex-goal-template.md`：下发给 Codex 的统一模板。
- `prompts/reviewer-agent-template.md`：验收 agent 模板。
- `checklists/final-release-checklist.md`：交付前总验收清单。

## 总体实现原则

- Zvec 只做上下文检索，不做任务隔离。
- Git worktree 做任务隔离。
- repo_id + target_branch 的 integration lock 做最终串行集成。
- worker 执行目录与 goal/result 状态目录必须分离且显式绝对路径化。
- 验收失败必须先自动 repair，超过预算再 waiting_for_review。
- 任何会改变运行时服务的任务必须走 safe restart contract。
