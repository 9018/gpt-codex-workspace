# Handoff For Agent

你是接手 GPTWork 产品化改造的实现 agent。

## 你要做什么

按 P0/P1/P2 优先级实施：

1. P0：CLI、tool mode、open_project_context、compact output、README quick start。
2. P1：agent_runs、handoff、watcher、show_changes、GitHub 协作增强。
3. P2：tool metadata、rich schema、event log/SQLite、hook/plugin、Apps SDK widget。

## 约束

- 不考虑安全问题。
- 不破坏现有工具名和兼容路径。
- 优先小步可验证改动。
- 每阶段完成后更新文档和测试。
- 若无法完成全部，至少交付 P0 可用闭环。

## 输出格式

最终输出：

```json
{
  "status": "completed|failed|timed_out",
  "summary": "...",
  "changed_files": [],
  "tests": "...",
  "warnings": [],
  "followups": []
}
```
