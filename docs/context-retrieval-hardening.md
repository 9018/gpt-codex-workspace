# Context Retrieval Hardening (P0 — 上下文污染修复)

## 文档记录

| 日期 | Goal/Task ID | 阶段 | 发现 |
|------|-------------|------|------|
| 2026-07-13 | goal_30f04dd5-cf6b-4e58-9b6d-7beae2a85c6e / task_4e74f274-3c56-40ca-beaf-3eeb9ec1b8eb | 1/5: 复现与失败测试 | 确认跨 Goal 上下文污染缺陷 |
| 2026-07-13 | goal_b871cbb7-a7ca-41c1-ba88-dae64fef4344 / task_3c08734f-90f6-4714-acd2-35d5f724787f | 2/5: 检索熔断与意图过滤 | 实现非语义检索熔断 + 意图/变更范围兼容过滤 |

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
    ├─ 原则 1: 当 semantic=false 时，禁止跨 Goal 检索 ✅ (Phase 2)
    ├─ 原则 2: 当前 Goal 强锚定 (current_goal_min=1 已实现) ✅ (Phase 1)
    ├─ 原则 3: 意图兼容过滤 (readonly vs mutation) ✅ (Phase 2)
    ├─ 原则 4: Mutation scope 过滤 (entry 从 acceptance contract 推导) ✅ (Phase 2)
    └─ 原则 5: Manifest/retrieval 可观测 (已实现) ✅ (Phase 1+2)
```

## 污染证据 (来自回归测试)

### Test 1: 跨 Goal 检索污染确认 (Phase 1 — 永久 RED 证据保留)

```
查询: "Read-only diagnostic check of system health. Inspect log files..."

搜索结果:
  [CROSS] score=-0.181392  goal=goal_test_mutation_deployment  type=goal
    text: "## Title Deploy Configuration Update ## User Request Modify deployment
           configuration files and restart services. Edit /etc/app/config.yml..."
  [GOAL_A] score=-0.476941  goal=goal_test_readonly_diagnostic  type=goal
    text: "## Title System Health Diagnostic Check ## User Request Read-only..."

结论: 1 个 mutation Goal 的 chunk 在 readonly query 下被返回。排名甚至高于正确结果。
即使 Phase 2 修复生效后，store 层仍可复现此污染（验证熔断的必要性）。
```

### Test 3/Phase2: retrieval.json 元数据确认 (Phase 2 — 证明熔断生效)

```json
{
  "cross_goal_retrieval": { "enabled": false, "disabled_reason": "non_semantic_embedding" },
  "embedding_provider": {
    "name": "fallback-hash-sha256",
    "semantic": false,
    "support_info": "non-semantic fallback embedding provider; deterministic hash-based vectors for testing/offline use"
  },
  "budget": { "cross_goal_enabled": false, "is_readonly_goal": true }
}
```

## Phase 2 实现记录

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/context-index/context-index-hooks.mjs` | - 添加 `isReadonlyOrDiagnosticGoal()` 意图检测函数<br>- 添加 `analyzeChunkMutationContent()` chunk 变异内容分析<br>- 添加 `analyzeChunkIntent()` chunk 意图分类<br>- `buildRetrievalJson()` 接受 `crossGoalEnabled` 参数，动态设 `enabled`<br>- `buildRetrievalJson()` 为每个候选添加 included/excluded、reason、source_goal_id、intent、mutation_scope、semantic_capability<br>- `maybeBuildContextBundle()` 在 Phase 1 前检查 `embeddingProvider.semantic`<br>- `maybeBuildContextBundle()` 当 `semantic=false` 时设 `crossGoalTopK=0`<br>- 构建 `manifestWarnings` 数组包含 3 类警告 |
| `src/context-index/context-bundle-builder.mjs` | - `selectBundleChunks()` 添加意图兼容过滤<br>- 添加 `isReadonlyOrDiagnosticGoal()` 函数 |
| `test/context-retrieval-hardening.test.mjs` | - 更新 Phase 1 断言 (enabled=true → enabled=false)<br>- 新增 Phase 2 测试套件 T1-T10 |

### 关键决策

1. **非语义检索熔断**：在 `maybeBuildContextBundle()` 中 Phase 1 开始前检查 `embeddingProvider.semantic`，当 `semantic=false`（如 fallback-hash-sha256）时设置 `crossGoalEnabled=false`，跳过 Phase 1 cross-goal 检索。`retrievalJson` 中的 `cross_goal_retrieval.enabled` 相应设为 false。
2. **意图兼容过滤**：两层过滤——(a) 在 `maybeBuildContextBundle` 中 `buildRetrievalJson()` 标记每个候选的 included/excluded；(b) 在 `selectBundleChunks()` 中跳过 intent-mismatch 的 cross-goal chunk。
3. **候选追踪**：`context.retrieval.json` 中 `cross_goal_retrieval.candidates[]` 记录每个候选的 `included`、`reason`、`source_goal_id`、`intent`、`mutation_scope`、`semantic_capability`。
4. **Manifest 警告**：`context.manifest.json` 的 `warnings[]` 包含 `non_semantic_embedding`、`cross_goal_retrieval_disabled`、`intent_mismatch`。

### 风险

1. **向后兼容**：`semantic=false` 是 fallback provider 特有，semantic provider 不受影响
2. **意图检测误报**：基于文本信号检测，复杂描述可能被误分类，但目的是保守安全
3. **Phase 1 测试仍 RED**：有意保留 store 层污染测试作为硬性证据

### 测试命令与结果

```bash
cd backend && node --test test/context-retrieval-hardening.test.mjs
```

**结果**: 15 tests, 14 pass, 1 fail (expected store-level contamination test)
- Phase 1 store 层污染证据: **FAIL** (by design, permanent RED — 证明熔断必要性)
- Phase 1 diagnostics: PASS
- Phase 2 T1-T5 (检索熔断验证): **ALL PASS**
- Phase 2 T6 (意图分类): **PASS**
- Phase 2 T7-T10 (边界/兼容性): **ALL PASS**

```bash
cd backend && node --test 'test/*.test.mjs' --timeout=30000 2>&1 | tail -5
```

完整回归测试: 见下方回归结果

## 回归测试结果

```
tests 15
suites 7
pass 14
fail 1   (期望的 store 层污染测试)
```



## Phase 3 实现记录

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/context-index/context-bundle-builder.mjs` | - `buildGoalAnchorSection()` 替代 `buildContextSummarySection()`，固定输出 Goal Title、User Request、Goal Prompt、Metadata、Acceptance Constraints<br>- `buildHistoricalContextNote()` 新增，历史内容标注为 Optional Historical Context<br>- `buildPriorityBudgetSection()` 新增，展示当前 Goal 最低预算和最高优先级<br>- `_appendContractConstraints()` 新增，从 acceptance contract 提取约束显示<br>- 节序重组：Goal Anchor → Priority & Budget → Optional Historical Context → Transcript Note → Retrieval Sources |
| `src/context-index/entry-contract-deriver.mjs` | (新) 提供 `isReadonlyOrDiagnosticContract()`, `getExecutionModeLabel()`, `getMutationScopeLabel()`, `buildEntryExecutionDiagnostics()`, `sanitizeReadonlyInstructions()` 函数 |
| `src/acceptance/contract-schema.mjs` | 新增 `normalizeContractCustomFields()` — 检测并消除 top-level `execution_mode` / `mutation_scope` 与 `intent.*` 块的冲突 |
| `src/acceptance/semantics.mjs` | `validateContractSemantics()` 集成自定义字段归一化，`intent` 块为单一权威来源 |
| `src/goal-files.mjs` | `renderCodexEntryMarkdown()` 新增 `Execution Diagnostics` 节，显示推导出的 execution mode 和 mutation scope |
| `test/context-retrieval-hardening.test.mjs` | 新增 Phase 3 测试 T1-T9 |

### 关键决策

1. **Goal Anchor 优先**：`context.bundle.md` 首段 `## Current Goal Anchor` 固定输出当前 Goal 标题、User Request、Goal Prompt、Metadata 和 Acceptance Constraints（若有 contract）。随后是 `## Optional Historical Context`，明确标注"不得覆盖 Goal Anchor"。
2. **Entry 从 contract 推导**：`codex.entry.md` 新增 `## Execution Diagnostics` 节，显示从 `acceptance.contract.json.intent` 推导的 Execution mode 和 Mutation scope。readonly diagnostic 显示 "Execution mode: readonly diagnostic"、"Mutation scope: none"。
3. **自定义字段归一化**：`normalizeContractCustomFields()` 检测 top-level `execution_mode`/`mutation_scope` 与 `intent` 块的冲突，移除冲突的 top-level 字段并产生 warning。`validateContractSemantics()` 集成此检查。
4. **Readonly sanitize**：`sanitizeReadonlyInstructions()` 将 readonly mode 下的 mutation 命令（restart/deploy/commit 等）替换为安全分析指令。
5. **历史内容隔离**：旧 conversation/result section 标注为 `## Optional Historical Context`，明确提示不覆盖当前 Goal。

### 测试命令与结果

```bash
cd backend && node --test test/context-retrieval-hardening.test.mjs
```

**结果**: 24 tests, 23 pass, 1 fail (expected store-level contamination)
- Phase 1 store 层污染证据: **FAIL** (by design, permanent RED)
- Phase 1 diagnostics: PASS
- Phase 2 T1-T10: **ALL PASS**
- Phase 3 T1-T9: **ALL PASS**
  - T1: 验证 Current Goal Anchor 在 bundle 首段
  - T2: 验证 Optional Historical Context 标注和 override warning
  - T3: 验证 Acceptance Constraints 显示
  - T4: 验证 normalizeContractCustomFields 检测冲突
  - T5: 验证 clean contract 无 warning
  - T6: 验证 validateContractSemantics 集成归一化
  - T7: 验证 entry-contract-deriver 只读诊断输出
  - T8: 验证 sanitizeReadonlyInstructions 移除 mutation 命令
  - T9: 验证 renderCodexEntryMarkdown 包含 Execution Diagnostics

### 向后兼容

- 无 contract 时，`buildGoalAnchorSection` 只显示 Goal 信息，无 Acceptance Constraints
- `normalizeContractCustomFields` 只在检测到冲突时产生 warning，clean contract 无影响
- `buildEntryExecutionDiagnostics` 无 contract 时返回 "unknown"
- 旧 bundle 格式仍然可用（`buildContextBundle` 不破坏现有调用）
- `selectBundleChunks` 保持 Phase 2 意图兼容过滤

### 剩余风险

1. Entry 推导依赖 contract 存在；无 contract 的 goal 无法推导
2. Sanitize 使用简单的文本替换，可能过度替换（如 "commit" 在 git 上下文中被替换）
3. 跨 Goal 检索约束仍需 Phase 4-5 完善

## 复现步骤

```bash
cd backend && node --test test/context-retrieval-hardening.test.mjs
```

预期结果 (Phase 2 修复后):
- Phase 1 跨 Goal 污染测试 (store 层): RED (预期，验证熔断必要性)
- Phase 1 元数据测试: PASS (enabled=false)
- Phase 2 T1-T10: ALL PASS

## 修改文件清单 (阶段 1-2 完成)

| 文件 | 修改内容 | 状态 |
|------|---------|------|
| `src/context-index/context-index-hooks.mjs` | non-semantic cross-goal 熔断 + 候选追踪 + manifest 警告 | ✅ Phase 2 |
| `src/context-index/context-bundle-builder.mjs` | 意图兼容过滤 + Goal Anchor 首段结构化锚定 + Optional Historical Context 标注 | ✅ Phase 3 |
| `src/context-index/entry-contract-deriver.mjs` | (新) entry 从 acceptance contract 推导执行模式/mutation scope | ✅ Phase 3 |
| `src/acceptance/contract-schema.mjs` | normalizeContractCustomFields() 检测并消除 intent 与自定义字段冲突 | ✅ Phase 3 |
| `src/acceptance/semantics.mjs` | validateContractSemantics 集成自定义字段归一化 | ✅ Phase 3 |
| `src/goal-files.mjs` | renderCodexEntryMarkdown 添加 Execution Diagnostics 节 | ✅ Phase 3 |
| `test/context-retrieval-hardening.test.mjs` | 继承 Phase 1-2 测试 + 新增 Phase 3 T1-T9 测试 | ✅ Phase 3 |
| `docs/context-retrieval-hardening.md` | 本文档更新 | ✅ Phase 3 |

## 阶段 1-5 验证状态

1. ✅ `current_goal_min: 1` — Phase 1 完成
2. ✅ Token 预算 2048 — Phase 1 完成
3. ✅ `semantic=false` 时跨 Goal 禁止 — **Phase 2 完成**
4. ✅ 意图兼容/Mutation scope 过滤 — **Phase 2 完成**
5. ✅ Entry 从 acceptance contract 推导 — **Phase 3 完成**
6. ⏳ cross-goal 检索约束文档更新 — **Phase 2-5**
7. ✅ Goal 锚定与入口统一 — **Phase 3 完成**
8. ✅ 契约自定义字段冲突检测 — **Phase 3 完成**
9. ✅ context.bundle.md 首段固定输出当前 Goal 信息 — **Phase 3 完成**
10. ✅ readonly entry 不得含 mutation 指令 — **Phase 3 完成**
