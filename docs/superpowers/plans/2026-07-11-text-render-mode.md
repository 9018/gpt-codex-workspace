# GPTWork 纯文本渲染模式实施计划

**目标：** 默认关闭 Apps SDK v5 卡片，在移动端仅输出原生中文文本和受限结构化数据，同时保留 `card` 回退模式。

**方案：** 在统一运行配置中加入 `renderMode`，由 MCP 协议层按模式决定是否暴露 UI capability、卡片资源和工具 `_meta`。结果封装层继续生成受限 model payload，但 `text` 模式不构造或附加 card payload。中文文本由现有结果摘要层统一输出。

**技术栈：** Node.js ESM、MCP JSON-RPC、node:test。

---

## 任务 1：运行配置与模式判定

**文件：**
- 修改：`backend/src/runtime-config.mjs`
- 修改：`backend/src/gptwork-server.mjs`
- 修改：`.gptwork/runtime.env.example`
- 测试：`backend/test/runtime-config.test.mjs`

步骤：
1. 先添加默认值、合法值和非法值测试。
2. 运行测试确认失败。
3. 实现 `text|selective|card` 解析，默认 `text`，非法值明确报错。
4. 将 `renderMode` 注入服务器配置和来源跟踪。
5. 运行配置测试确认通过。

## 任务 2：按模式控制描述符、能力和资源

**文件：**
- 修改：`backend/src/apps-sdk-card/card-meta.mjs`
- 修改：`backend/src/mcp-tooling.mjs`
- 修改：`backend/src/gptwork-server.mjs`
- 测试：`backend/test/apps-sdk-card-smoke.test.mjs`

步骤：
1. 添加 `text` 模式无卡片元数据、无 UI extension、无资源的失败测试。
2. 添加 `card` 模式完整兼容测试。
3. 添加 `selective` 模式仅低频工具启用卡片的测试。
4. 实现中央模式判定和白名单。
5. 将模式传给 `toolList`、`initializeResult`、`resourceList`、`readResource`。
6. 运行 Apps SDK 测试确认通过。

## 任务 3：纯文本结果契约与中文摘要

**文件：**
- 修改：`backend/src/apps-sdk-card/tool-result.mjs`
- 修改：`backend/src/tool-result-summary.mjs`
- 测试：`backend/test/tool-result.test.mjs`
- 测试：`backend/test/card-payload-contract.test.mjs`

步骤：
1. 添加 `text` 模式保留可读文本和受限字段、删除 card 字段的失败测试。
2. 添加 `card` 模式原行为回归测试。
3. 实现无卡片 model payload 构建路径。
4. 为高频状态、任务、目标、队列和项目上下文输出紧凑中文摘要。
5. 运行结果契约测试确认通过。

## 任务 4：文档、部署与验证

**文件：**
- 修改：`docs/widget-card.md`
- 修改：`README.zh-CN.md`
- 修改：`.gptwork/runtime.env`

步骤：
1. 文档说明默认纯文本、三种模式和刷新连接要求。
2. 将当前部署设为 `GPTWORK_RENDER_MODE=text`。
3. 执行语法检查、导入检查、聚焦测试和完整后端测试。
4. 提交实现。
5. 重启 GPTWork。
6. 验证 initialize、tools/list、resources/list、runtime_status/worker_status 均不再产生卡片元数据，并确认中文文本可读。
