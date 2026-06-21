# Global Acceptance Criteria

## P0

- CLI 可执行并覆盖 setup/start/status/doctor/settings。
- 默认 tool mode 收束工具面。
- 新增 `open_project_context` 并被 README 推荐为 ChatGPT 第一工具。
- 结果输出 compact，不再默认刷大段 raw logs。
- README 首屏可在 5 分钟内指导新用户跑起来。

## P1

- 支持真实 `agent_runs`。
- 支持 handoff plan 文件。
- 支持 watcher CLI dry-run。
- 支持 `show_changes`。
- GitHub Issue comment 能呈现 progress/result。

## P2

- tool registry 有 metadata。
- schema builder 更丰富。
- event log 或 SQLite 方案落地其一。
- hook 机制至少接入一个现有功能。
- 至少一个真正 App SDK widget card。
