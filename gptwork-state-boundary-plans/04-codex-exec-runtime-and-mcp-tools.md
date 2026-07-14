# Codex Exec Runtime and MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Codex 非交互执行模式实现为独立 provider 和 MCP 工具组，同时与 TUI 共用 Execution、Evidence、Finalizer 和 Task Transition 内核。

**Architecture:** 新增 `codex_exec` provider，使用 `child_process.spawn` 执行非交互 Codex 命令，持续写 execution log，完成后收集统一 evidence。对 ChatGPT 暴露对称的 start/status/logs/collect/cancel 工具，但仍归属同一个 `@workmcp`。

**Tech Stack:** Node.js ESM、`child_process.spawn`、现有 worktree/lock/context/evidence infrastructure。

## Global Constraints

- 一个 `@workmcp` 用户入口。
- Exec 和 TUI 使用不同工具组。
- Exec provider 不解析 TUI。
- 不允许 shell 字符串拼接执行；使用 argv。
- 默认非交互。
- 取消、超时、进程丢失必须有稳定语义。
- 收集后走同一个 evidence application service。

---

## 文件结构

### 新建

- `backend/src/providers/codex-exec-execution-provider.mjs`
- `backend/src/codex-exec/codex-exec-process-runner.mjs`
- `backend/src/codex-exec/codex-exec-command-builder.mjs`
- `backend/src/codex-exec/codex-exec-result-collector.mjs`
- `backend/src/tool-groups/codex-exec-tools-group.mjs`
- `backend/test/codex-exec-process-runner.test.mjs`
- `backend/test/codex-exec-execution-provider.test.mjs`
- `backend/test/codex-exec-result-collector.test.mjs`
- `backend/test/codex-exec-tools-group.test.mjs`

### 修改

- `backend/src/server-tools.mjs`
- `backend/src/public-tool-catalog.mjs` 或实际工具 registry 文件
- `backend/src/codex-execution-provider.mjs`
- `backend/test/public-tool-names.test.mjs`
- `docs/codex-exec-production-mode.md`
- `docs/chatgpt-prompting-guide.md`

---

## Task 1：命令构建器

**Files:**
- Create: `backend/src/codex-exec/codex-exec-command-builder.mjs`
- Test: `backend/test/codex-exec-process-runner.test.mjs`

API：

```js
buildCodexExecCommand({
  binary = "codex",
  cwd,
  contextEntryPath,
  outputSchemaPath,
  model,
  sandbox,
  approvalPolicy,
  extraArgs = [],
})
```

返回：

```js
{
  file: "codex",
  args: [
    "exec",
    "--cwd", cwd,
    "--json",
    "--output-schema", outputSchemaPath,
    "--sandbox", "workspace-write",
    "--approval", "never",
    contextPrompt,
  ],
  env: {
    ...safeEnv,
    GPTWORK_EXECUTION_ID: executionId,
  },
}
```

要求：

- `cwd` 由 runtime service 提供，不接受用户任意路径。
- 禁止 `shell: true`。
- extraArgs 使用 allowlist。
- contextPrompt 只引用 `codex.entry.md`，不内联完整 transcript。
- 输出要求写：
  - result.json
  - result.md
  - structured verification
- 环境变量过滤 secret 日志。

测试：

- 路径含空格仍作为单个 argv。
- 非 allowlist 参数失败。
- 不生成 shell command string。
- context path 越界失败。

---

## Task 2：进程 runner

**Files:**
- Create: `backend/src/codex-exec/codex-exec-process-runner.mjs`
- Test: `backend/test/codex-exec-process-runner.test.mjs`

API：

```js
createCodexExecProcessRunner({
  spawnFn = spawn,
  executionStore,
  processRegistry,
  now,
})
```

Start：

```js
const child = spawn(file, args, {
  cwd,
  env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
});

processRegistry.set(executionId, child);

child.stdout.on("data", chunk =>
  executionStore.appendExecutionLog(executionId, redact(chunk))
);
child.stderr.on("data", chunk =>
  executionStore.appendExecutionLog(executionId, redact(chunk))
);
```

运行态持久化：

```js
runtime_details: {
  pid,
  process_started_at,
  last_output_at,
  stdout_bytes,
  stderr_bytes,
}
```

退出：

```js
{
  exit_code,
  signal,
  ended_at,
  termination_reason:
    timedOut ? "timed_out" :
    cancelled ? "cancelled" :
    exitCode === 0 ? "completed" : "failed"
}
```

取消：

1. `SIGTERM`
2. 等待 grace period
3. `SIGKILL`
4. 写 execution transition
5. 不直接改 Task terminal 状态

恢复：

- 服务重启后 PID 存活但 child handle 丢失：
  - status=`lost`
  - 尝试只读 PID 检查
  - 不重新 attach stdout
  - 允许 collect durable artifacts

---

## Task 3：Exec result collector

**Files:**
- Create: `backend/src/codex-exec/codex-exec-result-collector.mjs`
- Test: `backend/test/codex-exec-result-collector.test.mjs`

复用通用 evidence helpers，不复制 TUI collector。

输入：

```js
collectCodexExecEvidence({
  execution,
  resultArtifactResolver,
  gitEvidenceCollector,
  verificationParser,
})
```

证据来源优先级：

1. execution-specific structured output
2. canonical goal `result.json`
3. worktree goal fallback
4. git evidence
5. process exit evidence

必须检测：

- artifact freshness
- result JSON schema
- changed file vs commit consistency
- verification command exit codes
- worktree dirty
- no-change explanation
- process exit code 与 reported status 冲突

冲突示例：

```js
if (exitCode !== 0 && result.status === "completed") {
  blockers.push({
    code: "process_result_status_conflict",
    message: "Codex process failed but result reports completed",
  });
}
```

---

## Task 4：Exec provider adapter

**Files:**
- Create: `backend/src/providers/codex-exec-execution-provider.mjs`
- Test: `backend/test/codex-exec-execution-provider.test.mjs`

实现标准 provider interface：

```js
export function createCodexExecExecutionProvider({
  runner,
  collector,
}) {
  return {
    name: "codex_exec",

    capabilities() {
      return {
        interactive: false,
        supports_send_input: false,
        supports_attach: false,
        supports_streaming_logs: true,
      };
    },

    async start({ execution, request, cwd }) {
      const started = await runner.start({
        executionId: execution.id,
        cwd,
        request,
      });
      return {
        provider_run_id: `process_${started.pid}`,
        runtime_details: started,
      };
    },

    status({ execution }) {
      return runner.status(execution.id);
    },

    stop({ execution }) {
      return runner.cancel(execution.id, { reason: "stop_requested" });
    },

    cancel({ execution }) {
      return runner.cancel(execution.id, { reason: "cancelled" });
    },

    collect({ execution }) {
      return collector.collect({ execution });
    },

    readLogs({ execution, maxChars }) {
      return executionStore.readExecution(execution.id, { maxChars });
    },
  };
}
```

---

## Task 5：新增 MCP 工具组

**Files:**
- Create: `backend/src/tool-groups/codex-exec-tools-group.mjs`
- Modify: `backend/src/server-tools.mjs`
- Modify: tool catalog/registry
- Test: `backend/test/codex-exec-tools-group.test.mjs`
- Modify: `backend/test/public-tool-names.test.mjs`

工具：

### `codex_exec_start`

输入：

```js
{
  task_id: "string",
  timeout_ms?: "integer",
}
```

处理：

```js
return executionRuntime.start({
  request_id: randomUUID(),
  task_id,
  provider: "codex_exec",
  interaction_mode: "batch",
  timeout_ms,
});
```

### `codex_exec_status`

输入：

```js
{ execution_id: "string" }
```

返回：

```js
{
  execution_id,
  provider: "codex_exec",
  execution_status,
  task_id,
  task_status,
  started_at,
  elapsed_ms,
  process: {
    pid,
    exit_code,
    signal,
  },
  next_action,
}
```

### `codex_exec_logs`

输入：

```js
{
  execution_id: "string",
  max_chars?: "integer",
}
```

不返回 secrets，不返回完整 env。

### `codex_exec_collect`

```js
const evidence = await executionRuntime.collect({ execution_id });
const applied = await evidenceApplication.apply({ execution_id });
return {
  execution_id,
  evidence,
  task_status: applied.task.status,
  canonical_decision: applied.task.result.unified_decision,
};
```

### `codex_exec_cancel`

```js
return executionRuntime.cancel({
  execution_id,
  reason: "operator_cancelled",
});
```

工具 metadata：

```js
{
  modes: ["standard", "operator", "codex", "full"],
  audience: ["chatgpt", "codex", "operator"],
  tags: ["codex", "exec"],
}
```

不要新增第二个插件名。

---

## Task 6：路由与默认策略

**Files:**
- Modify: `backend/src/codex-execution-provider.mjs`
- Test: `backend/test/codex-execution-provider.test.mjs`
- Test: `backend/test/codex-tui-provider-routing.test.mjs`

新增决策函数：

```js
selectCodexExecutionProvider({
  requestedProvider,
  task,
  config,
})
```

优先级：

1. 用户显式指定 provider。
2. Task metadata `execution_provider`.
3. 需要交互：
   - `requires_interaction=true`
   - `manual_intervention_expected=true`
   → TUI
4. 默认 → Exec。
5. provider disabled → 返回可解释 blocker，不静默 fallback，除非配置显式允许。

输出：

```js
{
  provider: "codex_exec",
  reason: "default_non_interactive_execution",
  fallback_allowed: false,
}
```

---

## Task 7：文档与 ChatGPT 工具心智

**Files:**
- Modify: `docs/codex-exec-production-mode.md`
- Modify: `docs/codex-tui-mode.md`
- Modify: `docs/chatgpt-prompting-guide.md`

写清：

```text
确定性、一次性、无人值守任务 → codex_exec
需要中途观察、输入或人工接管 → codex_tui
```

工具响应都带：

- `mode`
- `execution_id`
- `task_id`
- `status`
- `next_action`

不要让 ChatGPT 根据内部 session 字段猜下一步。

---

## Task 8：验收

运行：

```bash
cd backend
node --test \
  test/codex-exec-process-runner.test.mjs \
  test/codex-exec-execution-provider.test.mjs \
  test/codex-exec-result-collector.test.mjs \
  test/codex-exec-tools-group.test.mjs \
  test/codex-execution-provider.test.mjs \
  test/public-tool-names.test.mjs
npm run check:syntax
npm run check:imports
```

E2E 场景：

1. Exec 成功 code change。
2. Exec 成功 no-change diagnostic。
3. 非零 exit。
4. timeout。
5. cancel。
6. service restart 后 lost process + durable evidence。
7. collect 重放。
8. Exec/TUI 对同一 evidence fixture 产生相同 unified decision。
