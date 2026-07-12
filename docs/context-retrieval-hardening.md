# Context Retrieval Hardening (P0 — 上下文污染修复)

## 文档记录

| 日期 | Goal/Task ID | 阶段 | 发现 |
|------|-------------|------|------|
| 2026-07-13 | goal_30f04dd5-cf6b-4e58-9b6d-7beae2a85c6e / task_4e74f274-3c56-40ca-beaf-3eeb9ec1b8eb | 1/5: 复现与失败测试 | 确认跨 Goal 上下文污染缺陷 |

---

## 根因树 (Root Cause Tree)

```
[缺陷] readonly diagnostic goal 错误召回 mutation goal 的内容
│
├─ 直接原因: cross_goal_retrieval 开启时未检查 embedding 语义能力
│   ├─ context-index-hooks.mjs:715  buildRetrievalJson() 硬编码 enabled: true
│   ├─ context-index-hooks.mjs:376  Phase 1 跨 Goal 检索无 goal_id 过滤
│   └─ zvec-store.mjs:372  local store search 遍历所有 goal_id 目录
│
├─ 根本原因: fallback-hash-sha256 (non-semantic) 不能区分意图
│   ├─ embeddings.mjs:27  hashEmbed() 使用 SHA-256 确定性哈希
│   ├─ embeddings.mjs:131  semantic: false (明确标记无语义能力)
│   └─ retriever.mjs:90  检索时 embeddingConfig.provider 固定为 "fallback"
│
├─ 传播路径: 污染 chunk 经过 selectBundleChunks 进入 context.bundle.md
│   ├─ context-bundle-builder.mjs:280  selectBundleChunks 允许 cross-goal 进入
│   └─ context-bundle-builder.mjs:213  mergerRetrievedChunks 将 cross-goal 排在 second
│
└─ 修复原则 (用于阶段 2-5):
    ├─ 原则 1: 当 semantic=false 时，禁止跨 Goal 检索
    ├─ 原则 2: 当前 Goal 强锚定 (current_goal_min=1 已实现)
    ├─ 原则 3: 意图兼容过滤 (readonly vs mutation)
    ├─ 原则 4: Mutation scope 过滤 (entry 从 acceptance contract 推导)
    └─ 原则 5: Manifest/retrieval 可观测 (已实现)
```

## 污染证据 (来自回归测试)

### Test 1: 跨 Goal 检索污染确认

```
查询: "Read-only diagnostic check of system health. Inspect log files..."

搜索结果:
  [CROSS] score=-0.181392  goal=goal_test_mutation_deployment  type=goal
    text: "## Title Deploy Configuration Update ## User Request Modify deployment
           configuration files and restart services. Edit /etc/app/config.yml..."
  [GOAL_A] score=-0.476941  goal=goal_test_readonly_diagnostic  type=goal
    text: "## Title System Health Diagnostic Check ## User Request Read-only..."

结论: 1 个 mutation Goal 的 chunk 在 readonly query 下被返回。排名甚至高于正确结果。
```

### Test 3: retrieval.json 元数据确认

```json
{
  "cross_goal_retrieval": { "enabled": true },
  "embedding_provider": {
    "name": "fallback-hash-sha256",
    "semantic": false,
    "support_info": "non-semantic fallback embedding provider; deterministic hash-based vectors for testing/offline use"
  }
}
```

## 复现步骤

```bash
cd backend && node --test test/context-retrieval-hardening.test.mjs
```

预期结果 (修复前):
```
not ok 1 - cross-goal retrieval with fallback-hash-sha256 should NOT return mutation chunks
  error: 'CONTAMINATION DETECTED: 1 chunk(s) from mutation Goal B were returned'
```

预期结果 (修复后): 所有测试 PASS。

## 拟修改文件清单 (阶段 2-5)

| 文件 | 修改内容 | 优先级 |
|------|---------|--------|
| `src/context-index/context-index-hooks.mjs` | 在 Phase 1 cross-goal 检索前检测 `embeddingProvider.semantic===false`，跳过跨 Goal 检索 | P0 |
| `src/context-index/context-index-hooks.mjs` | `buildRetrievalJson()` 将 `cross_goal_retrieval.enabled` 改为动态值而非硬编码 true | P0 |
| `src/context-index/retriever.mjs` | `retrieveContext()` 支持 `crossGoalEnabled` 参数，在检索时自动移除 goal_id 过滤 | P0 |
| `src/context-index/context-bundle-builder.mjs` | `selectBundleChunks()` 对 cross-goal chunk 添加意图不兼容过滤 | P1 |
| `src/context-index/context-bundle-builder.mjs` | 对不会语义 embed 的 provider 添加 `current_goal_only` 策略 | P1 |
| `src/goal-files.mjs` | `renderCodexEntryMarkdown()` 根据 acceptance contract 输出 mutation_scope | P2 |
| `docs/context-layer.md` | 更新 cross-goal 检索约束说明 | P2 |
| `test/context-retrieval-hardening.test.mjs` | 修复后更新断言：验证 cross-goal 被正确禁止 | 每阶段 |

## 当前 Goal 首段与最低预算

系统当前已验证保障:
1. ✅ `current_goal_min: 1` — 已实现 (context-bundle-builder.mjs:332-334)
2. ✅ Token 预算 2048 — 已实现 (context-bundle-builder.mjs:26)
3. ❌ `semantic=false` 时跨 Goal 禁止 — **缺失**，这是本修复链路的 P0
4. ❌ 意图兼容/Mutation scope 过滤 — **缺失** (阶段 2/3)
5. ❌ Entry 从 acceptance contract 推导 — **缺失** (阶段 4)

## 下一步 (阶段 2)

1. 在 `maybeBuildContextBundle()` Phase 1 前注入 `embeddingProvider.semantic` 检查
2. 当 `semantic === false` 时：
   - `crossGoalTopK = 0` (跳过 cross-goal 检索)
   - `retrievalJson.cross_goal_retrieval.enabled = false`
   - 添加诊断日志
3. 运行回归测试验证 Test 1 从 FAIL → PASS
4. 运行完整测试套件确认无回归

---

*此文档由阶段 1 自动创建。每完成一个阶段必须更新。*
