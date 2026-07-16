# 06 ChatGPT 代码分析速度与延迟工具发现方案

## 目标

减少会话初始化工具 schema、避免默认全仓扫描、建立项目摘要和按需检索，使 ChatGPT 在保持准确性的同时更快进入有效分析。

## 主要文件

### 修改

- `backend/src/server-tools.mjs`
- `backend/src/gptwork-server.mjs`
- `backend/src/tool-groups/tool-discovery-tools-group.mjs`
- `backend/src/tool-groups/runtime-status-tools-group.mjs`
- `backend/src/onboarding-init.mjs`
- `backend/src/context-index/context-index-hooks.mjs`
- `backend/src/context-index/context-bundle-builder.mjs`
- `backend/src/context-index/zvec-store.mjs`
- `backend/src/context-retrieval-policy.mjs`
- `backend/src/server-context.mjs`
- `.gptwork/runtime.env.example`
- `docs/delayed-tool-discovery.md`
- `docs/context-layer.md`

### 新增

- `backend/src/tool-discovery/tool-discovery-config.mjs`
- `backend/src/tool-discovery/tool-catalog-index.mjs`
- `backend/src/tool-discovery/tool-discovery-diagnostics.mjs`
- `backend/src/context-index/project-code-map.mjs`
- `backend/src/context-index/code-symbol-index.mjs`
- `backend/src/context-index/analysis-entry-bundle.mjs`
- `backend/src/context-index/context-budget-planner.mjs`
- `backend/src/context-index/context-telemetry.mjs`

### 测试

- 修改 `backend/test/delayed-tool-exposure.test.mjs`
- 修改 `backend/test/delayed-tool-thread-e2e.test.mjs`
- 修改 `backend/test/tool-discovery-tools-group.test.mjs`
- 新增 `backend/test/tool-discovery-runtime-diagnostics.test.mjs`
- 新增 `backend/test/analysis-entry-bundle.test.mjs`
- 新增 `backend/test/context-budget-planner.test.mjs`
- 新增 `backend/test/code-symbol-index.test.mjs`
- 修改 `backend/test/perf-smoke.test.mjs`

## 实施任务

### Task 1：配置解析规范化

不要直接到处写：

```js
process.env.GPTWORK_DELAYED_TOOL_DISCOVERY === "true"
```

集中为：

```js
parseBooleanEnv(value)
resolveToolDiscoveryConfig({ env, runtimeConfig })
```

支持显式诊断，但生产默认仍建议严格值。

### Task 2：启动时可观测性

`runtime_status` 返回：

```js
tool_discovery: {
  mode: "delayed",
  enabled: true,
  configured_value: "true",
  source: "process.env",
  initial_tool_count: 5,
  callable_tool_count: 169,
  catalog_revision
}
```

启动日志：

```text
[tool-discovery] mode=delayed listed=5 callable=169 revision=<hash>
```

### Task 3：唯一 tools/list 过滤路径

当前 `server-tools.mjs` 和 `gptwork-server.mjs` 都有相关逻辑，应收敛为一个函数：

```js
listExposedTools({ catalog, discoveryConfig, audience })
```

所有 transport 都调用它，防止一条链过滤、另一条链全量暴露。

### Task 4：bootstrap 工具固定 contract

首次仅暴露：

```text
health_check
runtime_status
open_project_context
tool_search
tool_describe
```

增加端到端测试，对原始 MCP `tools/list` 断言数量和名称。

### Task 5：tool catalog index

启动时构建轻量索引：

```js
{
  name,
  title,
  tags,
  audience,
  side_effect,
  execution_class,
  short_description,
  schema_digest
}
```

`tool_search` 默认不返回完整 schema；只有 `tool_describe` 返回指定工具 schema。

### Task 6：项目代码地图

构建 `.gptwork/context-index/code-map.json`：

```js
{
  revision,
  git_head,
  directories,
  files: {
    path: {
      line_count,
      exports,
      imports,
      responsibilities,
      test_files,
      content_digest
    }
  }
}
```

增量更新只处理 git diff 变化文件。

### Task 7：symbol index

使用静态解析或现有可用 parser 建立：

- export symbol。
- function/class。
- imports。
- call/reference 粗索引。
- test 覆盖映射。

禁止 ChatGPT 为定位一个函数读取整个大文件。

### Task 8：analysis entry bundle

`open_project_context` 默认返回小型入口包：

```js
{
  repo,
  current_blockers,
  architecture_summary,
  hot_files,
  recent_changes,
  relevant_symbols,
  recommended_queries
}
```

不返回巨大的 worktree 列表和全量历史；这些改为专用按需工具。

### Task 9：上下文预算规划器

输入任务后计算：

```js
{
  must_read,
  should_read,
  optional,
  excluded,
  estimated_size,
  retrieval_queries
}
```

优先：

1. 目标文件符号段。
2. 直接依赖。
3. 对应测试。
4. architecture/contract 文档。
5. 最近相关 diff。

### Task 10：大文件切片读取

新增或增强工具支持：

```text
read_symbol
read_function
read_file_ranges
find_references
read_related_tests
```

避免默认读取 1000+ 行文件全量内容。

### Task 11：缓存与失效

缓存键：

```text
git_head + file_digest + catalog_revision + task_intent_digest
```

Git HEAD 或文件 digest 不变时复用分析摘要。

### Task 12：遥测

记录：

- 初始工具 schema 字节数。
- open_project_context 字节数。
- 首次有效工具调用耗时。
- 检索候选 token。
- 最终 bundle token。
- 补读次数。
- 因缺上下文导致 repair 的比例。

### Task 13：性能门禁

`perf-smoke` 增加目标：

- delayed mode 初始工具数固定 5。
- bootstrap schema 总体积不随全量工具数线性增长。
- code-map 无变更增量刷新明显快于全量刷新。
- analysis entry bundle 大小有硬上限。
- 读取一个 symbol 不加载整文件。

## 验收命令

```bash
cd backend
node --test test/delayed-tool-exposure.test.mjs
node --test test/delayed-tool-thread-e2e.test.mjs
node --test test/tool-discovery-tools-group.test.mjs
node --test test/tool-discovery-runtime-diagnostics.test.mjs
node --test test/analysis-entry-bundle.test.mjs
node --test test/context-budget-planner.test.mjs
node --test test/code-symbol-index.test.mjs
npm run test:perf-smoke
npm run check:syntax
npm run check:imports
```
