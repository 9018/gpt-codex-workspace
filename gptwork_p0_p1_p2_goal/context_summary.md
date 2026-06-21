# Context Summary

本 goal 来源于对 GPTWork 最新全量结构和核心代码路径的分析。

已观察到：

- `backend/src/cli.mjs` 只是服务入口，不是面向用户的 CLI。
- `backend/src/server-tools.mjs` 默认注册大量 tool group，缺少 minimal/standard/full/operator/codex 等工具面模式。
- `backend/src/tool-result-summary.mjs` 和 `backend/src/card-*` 已有文本卡片格式，但还没有 CodexPro 那种 Apps SDK widget resource / outputTemplate。
- `docs/chatgpt-prompting-guide.md` 和 README 中 `create_encoded_goal` 流程清晰，但对新用户偏重，需要一个高层 `open_project_context` 或类似入口。
- `createGoal` 中已有 `autonomy_policy`、`subagent_policy`，但多 agent 目前主要是 prompt/result.json 约定，不是真正的 agent run 编排。
- `StateStore` 已有 in-memory indexes 和 atomic save，但若进入多 agent/团队协作，应考虑事件日志或 SQLite。
- CodexPro 的 CLI、tool mode、compact bash transcript、handoff_to_agent、execute-handoff、watch-handoff、visual cards 对 GPTWork 使用体验很有参考价值。
