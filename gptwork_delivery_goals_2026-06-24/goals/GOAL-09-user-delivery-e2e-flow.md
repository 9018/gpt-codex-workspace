# GOAL-09：用户侧交付流程与 E2E 验收

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-07, GOAL-08

## 背景

用户侧交付不仅是代码能跑，还要从部署到 ChatGPT/Codex 对接，再到下发任务、执行、验收、结束任务形成闭环。

## 目标

形成 install/setup -> start backend -> connect ChatGPT MCP -> connect Codex -> self-test -> multi-goal tasks -> execute -> acceptance/repair -> integration -> completion notification 的完整流程。

## 需要修改/新增的文件

- `docs/setup-connect.md`
- `docs/e2e-acceptance.md`
- `docs/operations.md`
- `docs/delivery/user-delivery-flow.md`
- `backend/scripts/e2e-delivery-smoke.mjs`
- `backend/test/e2e-delivery.test.mjs`
- `backend/src/tool-groups/self-test-tools-group.mjs`
- `backend/src/diagnostics-service.mjs`

## 具体实现步骤

1. 新增用户视角交付文档：安装依赖、runtime.env、启动、health/status/self-test、ChatGPT MCP URL、Codex plugin、创建 encoded goal、查看进度、查看验收、失败 repair、完成清理。
2. E2E smoke 模拟 3 个不同 goal，同 repo，生成 context.bundle，queue 启动，fake Codex runner 模拟两个通过一个失败，失败触发 repair，最终全部完成或明确 waiting_for_review。
3. self-test 扩展检查 repo registry、worktree root 可写、git、zvec/local context-index、queue tools、Codex executable/mock mode、acceptance profile、integration lock。
4. open_project_context/card 增加 active worktrees、active integrations、repair pending、acceptance failures、context-index mode、self-healing last action。
5. 文档不允许宣称未实现能力；每个步骤给出验证命令和失败处理。

## 验收条件

- 新用户按文档可从零部署到完成第一个任务。
- E2E smoke 能模拟三任务并发、一个 repair、最终完成。
- self-test 能提前发现 Codex 未配置、Zvec 不可用、worktree root 不可写。
- 文档与真实代码能力一致。

## 建议测试命令

```bash
npm --prefix backend test -- e2e-delivery
npm --prefix backend run test:e2e-acceptance
npm --prefix backend run check:syntax
```

## 完成定义

项目从开发者能调通变成用户可按文档部署、对接、下发、自动验收完成。
