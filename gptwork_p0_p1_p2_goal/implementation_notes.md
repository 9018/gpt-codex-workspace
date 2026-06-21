# Suggested Implementation Notes

## Suggested Order

1. P0 CLI shell:
   - 先做 `gptwork doctor/status/settings show`，不要一开始做所有命令。
   - 复用现有 runtime_status/gptwork_doctor 逻辑，不复制诊断逻辑。

2. Tool mode:
   - 在 `createTools` 后做 filter 最快。
   - 长期再把 metadata 下沉到每个 tool group。

3. `open_project_context`:
   - 复用 `project_context_status`、`runtime_status`、`worker_status`、repo registry、file tree 逻辑。
   - 先返回 machine-readable + compact text。
   - 不要读取过多源码，控制 file tree 和 README/project.md bytes。

4. Cards:
   - 先统一 text card。
   - 再做 App SDK widget。

5. P1 agent_runs:
   - 先落 state schema 和 tools。
   - 再接 worker pipeline。
   - 最后做 external watcher。

## Suggested Files To Touch First

- `backend/package.json`
- `backend/src/cli.mjs`
- `backend/src/runtime-config.mjs`
- `backend/src/server-tools.mjs`
- `backend/src/mcp-tooling.mjs`
- `backend/src/tool-result-summary.mjs`
- `backend/src/card-*.mjs`
- `backend/src/tool-groups/context-health-tools-group.mjs`
- `backend/src/tool-groups/runtime-status-tools-group.mjs`
- `backend/src/tool-groups/goal-tools-group.mjs`
- `README.md`
- `docs/current-status.md`
- `docs/chatgpt-prompting-guide.md`

## Non-goals

- 不做安全审计。
- 不大改现有 goal/task 兼容路径。
- 不移除现有 GitHub Issues sync。
- 不一次性重写 StateStore。
