# GPTWork P0/P1/P2 Productization Goal

## 背景

当前仓库：`9018/gpt-codex-workspace`

最新分析聚焦点：

- 不考虑安全问题。
- 只考虑使用体验、拓展性、协作、多 agent、CLI 封装。
- 参考对象：`https://github.com/rebel0789/codexpro/`
- 当前 GPTWork 强项：远程后端、任务持久化、GitHub Issues、Codex worker、repo lock、restart 协议、结果回写。
- CodexPro 值得借鉴点：本地 CLI、setup/start/settings/doctor、tool mode、低噪声卡片、handoff/watch-handoff、多 agent 外部执行适配。

## 总目标

把 GPTWork 从“能跑的后台协调系统”升级为“用户能顺手启动、ChatGPT 能稳定调用、Codex/多 agent 能协作扩展的平台”。

## 实施原则

1. 保持现有 MCP 工具名和核心兼容路径不破坏。
2. 优先做产品入口、工具面收束、低噪声输出，而不是重写后端。
3. 所有新增能力要能被 ChatGPT、Codex、CLI 三种入口复用。
4. P0 必须可独立交付；P1/P2 可逐步落地。
5. 每个阶段都要有测试或至少 smoke check。
