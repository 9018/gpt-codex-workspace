# GPT-Codex Workspace

[中文主文档](README.zh-CN.md) | English

GPTWork is a backend MCP service that coordinates ChatGPT, Codex, and project workspaces. ChatGPT creates bounded goals, Codex executes them in isolated worktrees, and GPTWork records task state, compact context, verification evidence, review packets, and closure decisions.

The complete project documentation is maintained in Chinese at [README.zh-CN.md](README.zh-CN.md). This English README is intentionally short to avoid duplicating the operational contract.

## Current Shape

- ChatGPT should start with `open_project_context`, then use `create_encoded_goal` for implementation, deployment, maintenance, or multi-step work.
- Codex starts from `.gptwork/goals/<goal_id>/codex.entry.md` and prefers `context.bundle.md` over full goal context when a bundle exists.
- Review should use compact packets: `get_task_review_packet` and `get_task_acceptance_bundle`.
- Zvec is an optional rebuildable context index, not the source of truth. Durable facts live in goal/task/result state, Git, and runtime diagnostics.
- Verification means commands/checks passed. Acceptance means the user goal is satisfied. Integration means changes reached canonical main. Deployment means the running environment uses the expected commit/config. Closure means the task can be closed. Review means human judgment is needed; it is not automatically failure.

Important delivery boundaries: `branch_pushed != merged`, `pr_opened != merged`, `merged != deployed`, and `health 200 != running expected commit`. `quality_notes` and `non_blocking_followups` do not block current task closure.

## Quick Start

```bash
cd backend
npm install
npm link
gptwork setup
gptwork settings set GPTWORK_TOOL_MODE standard
gptwork start
```

In another shell:

```bash
cd backend
gptwork doctor --local
gptwork status --local
gptwork connect --local
gptwork self-test --local
curl http://127.0.0.1:8787/health
```

## Verification

```bash
cd backend
npm run check:syntax
npm run check:imports
node scripts/release-delivery-check.mjs --fast
```

For release candidates, run the full delivery gate:

```bash
cd backend
node scripts/release-delivery-check.mjs
```

The full gate covers both supported delivery modes: local/no-GitHub task
execution and optional GitHub Issues adapter intake. It also runs legacy task
compatibility checks so older task records can still be reviewed without
rewriting historical state.

## Main Docs

- [中文主文档](README.zh-CN.md)
- [Current status](docs/current-status.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Context and worktree contract](docs/delivery/context-and-worktree-contract.md)
- [Setup and connection](docs/setup-connect.md)
- [Goal queue](docs/goal-queue.md)
- [GitHub fallback](docs/github-fallback.md)

## Security

Do not put real tokens, `.env` contents, runtime secrets, GitHub tokens, or notification keys in README files, docs, goal payloads, results, or Issues. Use local ignored runtime configuration and secret stores.

## License

MIT
