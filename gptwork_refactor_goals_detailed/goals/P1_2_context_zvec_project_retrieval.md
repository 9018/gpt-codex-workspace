# P1-2 Goal：context-index/zvec 项目级检索修复

## 目标

修复当前 context-index/zvec MVP 的交付缺陷，让 context bundle 能用于项目级上下文，而不是只查当前 goal。

## 涉及文件

```text
backend/src/context-index/zvec-store.mjs
backend/src/context-index/retriever.mjs
backend/src/context-index/context-index-hooks.mjs
backend/src/context-index/context-bundle-builder.mjs
backend/src/context-index/embeddings.mjs
backend/test/context-index.test.mjs
```

## 必须修复

### 1. zvec adapter 保存 text/tokens

当前风险：add 时只保存 metadata，search 时从 metadata 读 text/tokens。

必须改成：

```js
await idx.add(chunks[i].id, vectors[i], {
  ...chunks[i].metadata,
  text: chunks[i].text,
  tokens: chunks[i].tokens,
  chunk_index: chunks[i].metadata?.chunk_index ?? chunks[i].index ?? i,
})
```

### 2. 检索范围扩大

`retrieveContext` 不应强制只查当前 goal_id。支持：

```js
{
  workspace_id,
  repo_id,
  goal_id,
  include_recent_results: true,
  source_types: ['goal', 'conversation', 'result', 'code_file']
}
```

MVP 至少做到：同一 workspace 的 recent completed results 可被检索并进入 bundle。

### 3. bundle source list

context.bundle.md 必须包含来源清单：

```text
## Retrieval Sources
- source_type=result goal_id=... score=...
- source_type=conversation goal_id=... score=...
```

### 4. embedding provider 配置

fallback hash embedding 只能作为 dev fallback。配置中应允许真实 provider。若未配置，bundle 里要标记：

```text
Embedding provider: fallback-hash-sha256 (non-semantic dev fallback)
```

## 验收标准

- [ ] zvec adapter 不丢 text/tokens。
- [ ] retrieveContext 支持不只按当前 goal_id 查。
- [ ] context bundle 有 Retrieval Sources。
- [ ] recent prior results 能进入 bundle。
- [ ] 测试覆盖 zvec/local store 的 text round-trip。
