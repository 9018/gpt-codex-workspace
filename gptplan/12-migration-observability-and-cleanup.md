# 12 迁移、兼容删除、指标和产品化收口方案

## 目标

安全迁移旧状态/session/配置，删除长期兼容旁路，并建立可量化的运行指标。

## 主要内容

### Schema Migration

新增版本：

- unified decision v2。
- progression command v1。
- execution attempt v1。
- pipeline profile v1。
- TUI autopilot state v1。
- Codex session manifest v1。

迁移器必须：

```text
plan
→ dry run
→ backup
→ apply
→ validate
→ write receipt
```

### Legacy 判定

禁止通过“字段缺失”推断 legacy。

使用：

```js
task.schema_version
task.created_at < enforcement_cutoff
```

新任务缺 pipeline/decision/attempt 属于故障。

### Session 迁移

- 双读单写。
- 旧 session 只读。
- 通过 cwd 和 project registry 明确归属后复制。
- SHA256 校验。
- resume smoke test。
- 写 manifest。
- 不自动删除旧文件。

### 配置收口

形成：

```text
.gptwork/effective-config.json
```

每个字段记录 value/source/scope/valid/restart_required。

提供稳定 profile：

```text
local
single-repo-production
multi-repo-production
```

production profile 要求：

- delayed tool discovery 开启。
- TUI autopilot 开启。
- progression actuator 开启。
- path context validation 开启。
- canonical decision strong gate 开启。

### 指标

必须记录：

- 自动终态收敛率。
- 服务重启恢复率。
- 无人工介入率。
- TUI 自动动作成功率。
- TUI prompt loop 次数。
- provider failover 成功率。
- repair 成功率。
- 状态不一致率。
- progression command 重试率。
- 上下文 bundle 大小。
- 首次有效分析延迟。
- 无效 Agent 调用比例。
- 每个角色边际价值。
- worktree/branch/session 保留量。

### Dashboard/Status

`runtime_status` 返回高层产品视图：

```js
{
  automation: {
    canonical_decision_gate,
    progression_actuator,
    tui_autopilot,
    provider_failover,
    restart_recovery
  },
  health: {
    unresolved_invariants,
    stuck_commands,
    stale_attempts,
    unreconciled_projections
  },
  performance: {
    initial_tool_count,
    analysis_entry_bytes,
    context_cache_hit_rate
  }
}
```

### 兼容删除顺序

1. 双写/投影验证。
2. 读路径切换到新事实源。
3. 运行一个稳定周期。
4. 禁止新代码读取 legacy 字段。
5. 删除 legacy writer。
6. 最后删除 legacy reader 和 migration-only code。

### Retention

迁移完成后才清理：

- terminal integrated worktrees。
- superseded commands。
-旧 decision projection。
- 旧 session 副本。
- 过期 context index。

所有清理先 dry-run，并写 audit receipt。

## 最终验收

```bash
cd backend
npm run check:syntax
npm run check:imports
npm test
npm run release:check
node scripts/autonomous-runtime-release-gate.mjs
```

生产 canary 要求：

1. 创建真实任务。
2. 强制选择 TUI。
3. 全程无人输入。
4. 自动完成代码、测试、result、验收、集成、queue 推进。
5. 中途注入一次服务重启。
6. 最终所有 projection 一致。
