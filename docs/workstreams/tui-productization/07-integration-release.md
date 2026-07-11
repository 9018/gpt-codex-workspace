# G7: 集成、端到端发布、文档与小时巡检契约

## 交付行为

G7 将 G1–G6 的独立产出集成为一个可运行的 Workstream 产品化系统。具体包括：

1. **端到端 Workstream 产品化验证**：创建 Workstream、绑定多上下文、fan-out 三个并行任务、独立 worktrees、结构化 subagents、自动验收、repair/convergence、join/integration、完成 Workstream。
2. **小时巡检契约**：覆盖正常推进、偏离纠正、停滞恢复、ChatGPT direct edit 优先、受限时 fallback repair task、幂等与文档强制。
3. **全局文档更新**：补全集成 commit，更新 `docs/current-status.md`、`README.md`、`README.zh-CN.md`。

## 受影响的接口和文件

### 新增测试文件

| 文件 | 范围 |
|---|---|
| `backend/test/e2e-workstream-productization.test.mjs` | 端到端 Workstream 产品化场景（~40 tests） |
| `backend/test/workstream-hourly-supervisor.test.mjs` | 小时巡检契约（~30 tests） |

### 更新文档

| 文件 | 范围 |
|---|---|
| `docs/workstreams/tui-productization/07-integration-release.md` | 本文：G7 集成发布说明 |
| `docs/workstreams/tui-productization/README.md` | Workstream 目录索引，标记 G7 完成 |
| `docs/current-status.md` | 全局状态更新，记录 G7 交付能力 |
| `README.md` | 英文入口，引用新文档 |
| `README.zh-CN.md` | 中文入口，引用新文档 |

## 测试结果

运行 `check:syntax` 检查所有文件语法错误：

```bash
# Syntax check — 所有 .mjs 文件无语法错误
```

运行两个集成测试文件：

```bash
# End-to-end workstream productization tests — 全部通过
# Hourly supervisor contract tests — 全部通过
```

### 端到端测试覆盖

| 场景 | 断言 |
|---|---|
| G1: createWorkstream — 创建 Workstream、默认策略 | id 以 `ws_` 开头，status=planned，策略正确 |
| G1: linkWorkstreamContext — 绑定多外部上下文 | 3 个 links，resolved 返回正确 workstream |
| G1: createWorkstream — CRUD 往返 | 创建/读取/更新/列表全部正确，不可变字段受保护 |
| G2: checkWorktreeDirty — 验证 worktree 状态 | 干净 repo 非 dirty，添加文件后 dirty |
| G3: subagent policy — 默认管线 | 7 个默认角色，repairer 在 ALL_PIPELINE_ROLES 中 |
| G4: createWorkstreamFanout — 3 路 fan-out | 父节点 fanout 类型，3 个子 shard，3 条边 |
| G4: createWorkstreamJoin — all_completed 合并 | join 节点 waiting，2 条 predecessor 边 |
| G4: fan-out idempotent、join idempotent | 重复调用返回 idempotent=true |
| G5: evaluateAcceptance — 完整证据通过 | verdict=passed, blocker_count=0 |
| G5: evaluateAcceptance — 缺失证据失败 | blocker_count > 0 |
| G5: runAcceptanceController — passed/repair | passed→acceptance_passed，failed→repair action |
| G5: buildRepairGoalPayload | repair_attempt 正确，assign_to_codex=true |
| G5: buildConvergenceGoalPayload | 标题包含 Convergence |
| G5: buildChatGptEscalationPayload | escalation_category 正确 |
| G5: scheduleRepairAction — 幂等 | 重复记录→deduplicated |
| G6: normalizeLegacyGoalWorkstream/TaskWorkstream | 兼容性正确 |
| G7: 完整 Workstream 流程 | 创建→链接→fan-out→join→AC→完成 |

### 小时巡检测试覆盖

| 场景 | 断言 |
|---|---|
| tickTaskAdvancement — 推进 eligible 任务 | assigned→queued, queued→running, waiting_for_lock→running |
| tickTaskAdvancement — 已推进任务不重复 | 含 tick_advanced 标记的任务跳过 |
| tickDriftDetection — 无漂移 | count=0 |
| detectDrift — 检测阶段错误 | WRONG_PHASE 漂移 |
| detectDrift — 检测范围错误 | WRONG_SCOPE 漂移 |
| detectDrift — 检测停滞进度 | STALE_PROGRESS 漂移 |
| detectDrift — 检测终态队列不匹配 | TERMINAL_QUEUE_MISMATCH 漂移 |
| detectDrift — 父终态时无漂移 | drifted=false |
| detectStall — 检测死 TUI 会话 | DEAD_TUI stall |
| detectStall — 检测停滞 worker | STALE_WORKER stall |
| detectStall — 检测陈旧锁 | STALE_LOCK stall |
| detectStall — 检测终态不匹配 | TERMINAL_MISMATCH stall |
| detectStall — 正常状态无停滞 | stalled=false |
| detectStall — 幂等 | 相同输入相同输出 |
| scheduleRepairAction — direct_correction 优先 | 有 corrections→direct_correction |
| scheduleRepairAction — fallback repair task | 无 corrections→create_repair_goal |
| scheduleRepairAction — 预算耗尽后 escalate | currentAttempt>=2→chatgpt_escalation |
| evaluateAcceptance — docs_only 强制文档 | 非 .md 文件→documentation_updated=fail |
| evaluateAcceptance — docs_only 有文档时通过 | 含 docs/ 文件→通过 |
| evaluateAcceptance — 非文档 profile 不要求文档 | summary="docs_not_required" |
| runTick — 完整 5 步 tick | 含 DRIFT_DETECTED, STALL_DETECTED, ACCEPTANCE_EVALUATED, TASK_ADVANCED, REVIEW_RECONCILED |
| 幂等性: evaluateAcceptance, detectDrift, detectStall, tickDriftDetection, tickStallDetection, scheduleRepairAction | 所有幂等性断言通过 |

## 兼容性和迁移说明

- G7 不创建任何平行替代 API。所有集成测试直接使用 G1–G6 导出的命名 export。
- 新增测试文件不修改任何既有模块，不改变已有行为。
- 文档更新仅追加 G7 相关能力，不修改既有历史章节。

## 已知限制

- `runTick` 的 acceptance evaluation 步骤需要已完成的 task 有 result 对象。
- `evaluateAcceptance` 的 docs_only 检查通过 `changed_files` 中的 `.md` 后缀文件判断，不解析文档内容。
- `scheduleRepairAction` 在 currentAttempt >= MAX_REPAIR_ATTEMPTS 后必定 escalate，不尝试跨 attempt 合并。

## 下一依赖

无。G7 是 Workstream 产品化的最终集成目标。

## 完成 Commit

集成 commit 包含 G7 的测试文件、文档更新和验证结果。
