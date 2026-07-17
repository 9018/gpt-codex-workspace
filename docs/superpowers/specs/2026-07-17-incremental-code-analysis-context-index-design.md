# 增量代码分析与上下文索引产品化设计

日期：2026-07-17
状态：设计完成，待实施计划

## 1. 目标

将 GPTWork 当前的代码分析流程从“每次扫描全仓、重新建立理解”升级为“混合增量索引 + Git 变更影响分析 + 历史分析缓存 + 按需源码回退”。

核心目标：

- 架构问题优先读取持久化索引和项目代码图。
- 变更审查只分析变更文件、相关符号、有限调用链和相关测试。
- 文件保存后轻量更新，Git commit 后强一致性校验。
- 索引证据不足时精确读取源码区间，不进行无界全仓回退。
- 分析结果以 AnalysisRecord 形式复用，并随证据版本自动失效。
- 所有分析受 token、文件数、字节数和调用链深度预算限制。

## 2. 推荐方案

采用混合模式：

1. 文件变化触发轻量增量更新。
2. commit 后执行基于 Git tree 的强一致性校验。
3. 所有分析请求进入统一 AnalysisQueryService。
4. 查询服务组合符号索引、项目代码图、Git diff、历史缓存和语义检索。
5. 只有证据覆盖不足时，才通过 SourceFallbackLoader 精确读取源码。

不采用纯 commit 模式，因为未提交修改会导致索引滞后；不采用纯实时模式，因为 watcher 丢事件、批量重构和分支切换可能造成索引漂移。

## 3. 现有能力复用

现有 `backend/src/context-index/` 已提供：

- `chunker.mjs`
- `embeddings.mjs`
- `zvec-store.mjs`
- `retriever.mjs`
- `code-symbol-index.mjs`
- `project-code-map.mjs`
- `context-budget-planner.mjs`
- `context-bundle-builder.mjs`
- `analysis-entry-bundle.mjs`
- `context-telemetry.mjs`
- `context-index-hooks.mjs`

本设计不替换这些模块，只补齐生命周期、变更影响分析、分析缓存和统一查询入口。

## 4. 总体架构

```text
File Watcher / Git Commit / Branch Switch
                │
                ▼
       IndexLifecycleCoordinator
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
Symbol Index  Code Map   Semantic Chunks
     │          │          │
     └──────────┼──────────┘
                ▼
        Persistent Index Store
                │
User Question / Review Request
                │
                ▼
        AnalysisQueryService
                │
     ┌──────────┼───────────────┐
     ▼          ▼               ▼
Git Delta   Impact Graph   Analysis Cache
     │          │               │
     └──────────┼───────────────┘
                ▼
       ContextBudgetPlanner
                │
                ▼
       EvidenceCoverageCheck
          │             │
       sufficient    insufficient
          │             │
          │             ▼
          │      SourceFallbackLoader
          │             │
          └──────┬──────┘
                 ▼
          AnalysisContextBundle
                 │
                 ▼
           ChatGPT / Codex
                 │
                 ▼
           AnalysisRecordStore
```

## 5. 核心组件

### 5.1 IndexLifecycleCoordinator

负责索引生命周期：

- 接收文件变化、commit、checkout、merge、rebase 事件。
- 计算新增、修改、删除和重命名文件。
- 调用符号索引、代码图和语义块索引。
- 维护索引版本与 Git 状态的绑定关系。
- 检测 watcher 丢事件和索引漂移。
- commit 后执行强一致性校验。

建议状态：

```json
{
  "schema_version": 1,
  "repo_root": "/repo",
  "branch": "main",
  "indexed_head": "<commit>",
  "working_tree_fingerprint": "<hash>",
  "last_full_validation_at": "<timestamp>",
  "status": "ready|updating|stale|failed",
  "file_count": 0,
  "symbol_count": 0,
  "chunk_count": 0
}
```

### 5.2 FileFingerprintStore

每个文件保存路径、SHA-256、语言、大小、索引时间、定义符号、引用符号、import/export 关系和语义块 ID。更新判断必须以内容 hash 为准，不能只依赖 mtime。

### 5.3 ChangeSetBuilder

统一计算：

- 索引基线到当前 HEAD 的已提交变化。
- HEAD 到工作区的未提交变化。
- 新增、修改、删除、重命名。
- 分支切换造成的批量变化。

### 5.4 ImpactGraphService

基于 `code-symbol-index` 和 `project-code-map` 展开有限影响范围：

1. 变更文件。
2. 变更符号。
3. 直接引用者。
4. 直接依赖项。
5. 相关测试。
6. 可配置的二级调用链。

默认限制：调用链深度 2、文件 30、符号 120、测试文件 20。超过预算时按相关性截断。

### 5.5 AnalysisQueryService

所有代码分析请求的唯一入口。处理顺序：

1. 读取 IndexState。
2. 必要时执行轻量索引刷新。
3. 识别问题意图和关键实体。
4. 构建 Git ChangeSet。
5. 查询历史 AnalysisRecord。
6. 构建影响图。
7. 查询符号、代码图和语义块。
8. 使用预算规划器选择上下文。
9. 检查证据覆盖度。
10. 必要时精确读取源码。
11. 输出 AnalysisContextBundle。
12. 保存 AnalysisRecord。

ChatGPT-facing 工具不得绕过该服务直接扫描全仓，除非显式进入 `force_full_scan` 诊断模式。

### 5.6 EvidenceCoverageCheck

检查关键实体、变更文件、定义、引用者、相关测试、目标文档和索引新鲜度是否覆盖。若不足，输出缺失项和建议源码读取范围。

### 5.7 SourceFallbackLoader

- 优先读取符号范围，不读取整个文件。
- 优先补齐缺失定义、引用点和测试。
- 每轮读取后重新评估覆盖度。
- 最多三轮。
- 达到预算仍不足时明确标记不确定性。

### 5.8 AnalysisRecordStore

缓存必须绑定：问题指纹、问题类别、repo HEAD、工作区指纹、索引版本、输入路径、输入符号和证据引用。

命中分级：

- Exact：问题和代码状态完全相同，直接复用。
- Incremental：问题类别相同且变化有限，只刷新受影响结论。
- Miss：关键实体或代码基线变化过大，重新分析。

## 6. 混合索引更新策略

### 文件保存阶段

采用 300–800ms debounce：

1. 计算文件 hash。
2. hash 未变化则跳过。
3. 更新该文件符号和语义块。
4. 更新直接依赖边。
5. 标记代码图为 `incrementally_valid`。

### Git commit 阶段

1. 比较 `indexed_head..HEAD`。
2. 验证所有变化文件已处理。
3. 清除删除文件残留。
4. 修复重命名关系。
5. 重建受影响依赖子图。
6. 更新 `indexed_head`。
7. 执行一致性校验。

### checkout、rebase、merge 阶段

变化文件低于阈值时增量处理；超过项目文件总数 20%、超过 500 个文件或 schema 变化时重建索引。

## 7. 上下文预算

| Profile | 用途 | 最大文件 | 最大源码字节 | 调用链深度 |
|---|---:|---:|---:|---:|
| fast | 状态与简单问答 | 12 | 120 KB | 1 |
| standard | 架构分析与代码审查 | 30 | 400 KB | 2 |
| deep | 产品化评估与疑难问题 | 80 | 1.2 MB | 3 |

优先级：用户指定文件、当前变更文件、关键定义、直接引用者、相关测试、方向/设计文档、语义相似内容。

## 8. ChatGPT 工具接口

建议只暴露三个高层工具：

- `analyze_project`：架构、产品化、方向符合度。
- `analyze_changes`：工作区或两个 Git ref 的变更审查。
- `explain_symbol`：单个符号、模块或调用链解释。

统一返回摘要、发现、置信度、分析文件、缓存状态、索引状态和源码回退次数。

## 9. 遥测与产品指标

记录：索引更新时间、增量文件数、全量重建次数、查询耗时、检索耗时、源码回退耗时、读取文件数/字节数、缓存命中、token 估算和证据覆盖分数。

目标：

- 上下文准备 P50 小于 3 秒。
- P95 小于 8 秒。
- 无变化重复问题 Exact 命中率高于 80%。
- 常规问题全仓扫描率低于 5%。
- 常规分析源码读取量下降 70% 以上。
- 索引漂移自动发现率 100%。

以上不包括外部大模型生成答案的网络延迟。

## 10. 错误处理与一致性

- watcher 失败：标记 stale，查询前用 Git diff 修复。
- 向量存储失败：降级到符号、代码图和关键词检索。
- AST 解析失败：保留文件级索引并记录 warning。
- Git 不可用：用文件 hash 增量处理并降低置信度。
- schema 不兼容：生成新版本并原子切换。
- 更新中断：禁止查询半成品索引。
- 单条缓存损坏：删除该记录，不影响主索引。

索引采用 generation 模型：

```text
index/generations/<generation-id>/...
index/current -> <generation-id>
```

查询只读取已完成 generation。实时更新可写 append journal，commit 校验后合并。

## 11. 测试设计

### 单元测试

文件失效、ChangeSet、重命名/删除、影响图预算、缓存判定、覆盖检查和源码回退。

### 集成测试

验证单文件增量、导出符号影响、删除清理、commit 推进、分支切换、watcher 丢事件修复和向量服务降级。

### 端到端测试

首次索引、架构提问、修改三个文件、变更影响提问、重复查询缓存、commit 一致性验证，并比较旧流程与新流程的耗时、读取量和证据覆盖。

## 12. 实施分期

### Wave 1：变更分析闭环

IndexState、FileFingerprintStore、ChangeSetBuilder、IndexLifecycleCoordinator 基础版、ImpactGraphService、`analyze_changes` 和基础遥测。

### Wave 2：分析缓存与统一入口

AnalysisQueryService、AnalysisRecordStore、Exact/Incremental cache、EvidenceCoverageCheck、SourceFallbackLoader、`analyze_project` 和 `explain_symbol`。

### Wave 3：实时 watcher 与强一致性

文件 watcher、Git 生命周期 hooks、generation 原子切换、漂移检测修复和索引健康诊断。

### Wave 4：产品化验收

性能基准、上下文质量评估集、运行面板、告警、发布门禁。

## 13. 第一版明确不做

- 完整编译器级全语言分析。
- 跨仓库全局知识图谱。
- 将未经验证的模型答案作为长期事实。
- 每次按键立即索引。
- 无预算递归调用链。
- 强依赖远程 embedding 服务。

## 14. 验收标准

1. 普通分析不再默认全仓扫描。
2. 未提交变化可在分析前进入索引。
3. commit 后索引基线与 HEAD 一致。
4. 变更审查覆盖变更文件、关键符号、直接引用者和相关测试。
5. 重复查询支持 Exact cache。
6. 小范围变化支持 Incremental cache。
7. 索引不足时只读取必要源码区间。
8. 所有分析返回证据范围、缓存状态、索引状态和置信度。
9. 索引故障有明确降级路径。
10. 端到端性能与正确性测试通过后才成为默认分析路径。
