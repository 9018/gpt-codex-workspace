# ChatGPT Encoded Goal Guide

Use this guide when ChatGPT needs to hand implementation, deployment, maintenance, or multi-step workspace work to Codex through GPTWork.

## Primary Rule

Start every new GPTWork session with `open_project_context` unless the user is asking for a narrow known task id. This gives ChatGPT the repo state, worker/queue status, recent tasks/goals, scripts, and recommended next tools in one compact response.

For complex execution requests, ChatGPT should not call direct shell tools or raw task assignment first. It should create an encoded goal:

1. Translate the user's request into a readable execution preview.
2. Show that preview to the user.
3. Put the same intent into payload JSON.
4. Base64 encode the JSON.
5. Call `create_encoded_goal` with `assign_to_codex: true` and a practical `wait_ms` when the user expects immediate progress.

Base64 is only transport encoding. It is not a secrecy mechanism and must not be treated as a way to hide intent. The backend stores readable `payload.json`, `goal.md`, `context.json`, and `transcript.md`; Codex reads the readable files.

## Preview Format

Example user request:

```text
删除旧部署，新增更新 xxx 到 xxx，连接 xxx，完成后验证服务。
```

ChatGPT should first show:

```text
我理解你的需求是：

目标：
删除旧部署，更新新版本到目标环境，并连接指定服务。

执行内容：
1. 检查当前部署状态。
2. 记录当前版本、容器、端口和服务配置。
3. 删除旧部署相关容器、目录或服务配置。
4. 上传或拉取新版本。
5. 按目标配置部署。
6. 连接指定地址或服务。
7. 验证端口、健康检查、日志和运行状态。
8. 将结果写回 GPTWork goal 和 Codex 会话。

目标环境：
xxx

连接信息：
xxx

验证要求：
返回端口、进程、服务状态、日志摘要、失败原因。
```

## Envelope

ChatGPT sends this shape to MCP:

```json
{
  "preview_text": "给用户看的明文说明",
  "payload_base64": "base64(JSON.stringify(payload))",
  "assign_to_codex": true
}
```

The decoded payload should be:

```json
{
  "user_request": "用户原始话",
  "goal_prompt": "Codex 要执行的完整明文指令",
  "context_summary": "这次会话上下文摘要",
  "mode": "deploy",
  "workspace_id": "hosted-default",
  "messages": [
    { "role": "user", "content": "用户原始话" },
    { "role": "chatgpt", "content": "GPTChat 明文翻译后的执行说明" }
  ],
  "memories": [],
  "attachments": []
}
```

Then call:

```text
create_encoded_goal({
  preview_text,
  payload_base64,
  assign_to_codex: true,
  wait_ms: 90000
})
```

`create_encoded_goal` returns a concise public file list by default: `dir`, `goal_md`, and `result_md`. Debug/context files such as `context.json`, `transcript.md`, `payload.json`, and `payload.base64` are still written, but are returned under `internal_files` or from `get_goal_context` so ChatGPT does not flood the user with paths. If `wait_ms` is provided, the response also includes `execution.status`, `execution.result`, and recent transcript messages; ChatGPT should show those instead of asking the user to poll a task id manually.

Return to the user:

```text
已创建 goal_id: ...
已创建/关联 task_id: ...
Codex 已接手。后端已保存 goal.md、context.json、transcript.md、payload.json。
```

## Modes

`create_task` no longer exposes a `mode` parameter. Ordinary tasks are always created as `builder`.

Execution elevation is selected after creation or through the goal flow:

- `builder`: default implementation, edits, tests.
- `deploy`: Docker, service deployment, port checks, health checks; select through `assign_task_to_codex` or goal creation.
- `admin`: privileged maintenance; select through `assign_task_to_codex` or goal creation.
- `readonly`: reserved for `create_codex_session_inventory_task`; ordinary task creation cannot request it.

Legacy clients may still send `mode`, but `create_task` ignores it and creates a `builder` task. Stored `standard` and ordinary `readonly` records are normalized to `builder`.

## Compatibility

These old paths are still supported by the backend but are not the recommended ChatGPT path:

- `create_goal` still creates readable shared goals.
- `create_task` automatically creates a linked goal.
- `assign_task_to_codex` automatically links old tasks to a goal.
- `create_task.description` may contain a `gptwork.encoded_goal.v1` envelope; the backend decodes it.

## Tool Modes

GPTWork defaults to `GPTWORK_TOOL_MODE=standard`, which keeps ChatGPT focused on goal/task, context, status, GitHub sync, handoff, and compact review tools. Operator/debug tools remain callable by known name for compatibility, but they are not advertised in the default `tools/list` surface.

Use these modes when configuring the backend:

- `minimal`: health/status, `open_project_context`, encoded goal, task reads.
- `standard`: normal ChatGPT usage.
- `codex`: Codex execution and workspace operations.
- `operator`: restart, diagnostics, repo lock, and sync operations.
- `full`: full compatibility/debug surface.

## Agent Handoff

For multi-agent collaboration, use `handoff_to_agent` to write `.gptwork/handoff/current-plan.md` and status artifacts, then use `read_handoff` or `gptwork watch-handoff --dry-run` to inspect the handoff. Use `create_agent_run`, `append_agent_event`, and `complete_agent_run` when work needs a tracked planner/implementer/tester/reviewer/finalizer trail. Use `show_changes` for a compact diff summary instead of pasting raw diffs.

## Attachments

Use two layers:

- Goal instructions: `JSON -> base64`.
- Files: `zip -> base64`.

Payload with bundles:

```json
{
  "goal_prompt": "...",
  "bundles": [
    {
      "name": "deploy-assets.zip",
      "zip_base64": "...",
      "sha256": "..."
    }
  ]
}
```

Backend files:

```text
.gptwork/goals/<goal_id>/attachments/deploy-assets.zip
.gptwork/goals/<goal_id>/attachments/deploy-assets/
```

## Good ChatGPT Behavior

- Keep the user's original request in `user_request`.
- Put the full operational instruction in `goal_prompt`.
- Keep `preview_text` and `goal_prompt` semantically identical.
- Include target environment, connection info, expected verification, and result format.
- Tell the user the decoded intent before calling `create_encoded_goal`.
- Do not treat base64 as hiding the command. It only preserves Chinese, newlines, JSON, and attachment references during transport.
