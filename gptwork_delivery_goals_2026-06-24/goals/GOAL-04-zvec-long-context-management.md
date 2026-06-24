# GOAL-04：Zvec 长 GPTChat 上下文管理生产化

> 适用仓库：`9018/gpt-codex-workspace`  
> 当前关注模块：`backend/src/*`、`backend/test/*`、`.gptwork/*`、`docs/*`  
> 执行角色建议：parent Codex + analyst + implementer + tester + reviewer + escalation_judge

## 依赖

GOAL-00

## 背景

当前 context-index 已有 zvec/local adapter，但 fallback embedding 是 hash，不具备语义检索；retrieval 范围偏当前 goal；失败只 console.warn，不适合交付。

## 目标

将 Zvec 作为长对话、多任务、多历史结果的 context-index 后端，生成足够相关、足够小、可追溯的 context.bundle.md。

## 需要修改/新增的文件

- `backend/src/context-index/embeddings.mjs`
- `backend/src/context-index/retriever.mjs`
- `backend/src/context-index/zvec-store.mjs`
- `backend/src/context-index/context-bundle-builder.mjs`
- `backend/src/context-index/context-index-hooks.mjs`
- `backend/src/goal-task-workspace-files.mjs`
- `backend/src/codex-prompt-builder.mjs`
- `backend/test/context-index.test.mjs`

## 具体实现步骤

1. 支持 GPTWORK_CONTEXT_VECTOR_STORE=auto|zvec|local|off。auto 优先 zvec 失败降级 local 并记录 warning；zvec 强制模式不可用时不得静默降级。
2. 保留 fallback hash，但在 context.retrieval.json 标记 semantic=false/provider=fallback-hash-sha256。
3. 新增 GPTWORK_CONTEXT_EMBEDDING_PROVIDER=openai|local|fallback 与 GPTWORK_CONTEXT_EMBEDDING_MODEL，允许真实 embedding provider。
4. 支持 retrieval scope：current_goal、workspace_recent、repo_recent、global_project。默认包含当前 goal、相关 GPTChat 片段、最近相关 prior results、project.md/env key summary、repo map。
5. 实现 hybrid/rerank：vectorScore、keywordScore、recencyScore、source_type weighting。
6. context.retrieval.json 必须记录 store_name、embedding_provider、semantic、retrieval_scope、query、results、warnings。
7. 新增 GPTWORK_CONTEXT_BUNDLE_MAX_TOKENS，超预算时分层裁剪而非简单 substring。

## 验收条件

- context.bundle.md 有来源、摘要、约束、历史、遗漏说明。
- context.retrieval.json 记录 provider、store、scope、score、warnings。
- fallback hash 明确标记 non-semantic。
- zvec 强制模式不可用时明确失败/warning。
- 长 transcript 不直接塞进 Codex prompt。

## 建议测试命令

```bash
npm --prefix backend test -- context-index
npm --prefix backend run check:syntax
```

## 完成定义

长 GPTChat 默认通过 Zvec/检索 bundle 给 Codex，完整 transcript 保留但不直接吞入初始上下文。
