# GPTWork Task: P0-P2 performance, efficiency, and UX improvements

Labels to apply on the GitHub Issue:

```text
gptwork-task
```

Task summary:

Implement the P0-P2 optimization plan from the latest full-code analysis, excluding security work. Focus only on efficiency, performance, and user experience.

Payload:

- ZIP base64: `.gptwork/goal-inbox/gptwork-p0-p2-codex-goal.zip.b64`
- Restore instructions: `.gptwork/goal-inbox/gptwork-p0-p2-codex-restore.md`
- SHA256: `569ba4ccb00c2d9b1e962e5a7f7b897d96eb6ce9b2dbfc7d96d6570946f33c80`

Codex execution:

1. Decode ZIP using restore instructions.
2. Read `goal.md` from the decoded ZIP.
3. Implement P0-P2 incrementally with tests.
4. Run `cd backend && npm test`.
5. If added, run `npm run check:syntax` and `npm run test:perf-smoke`.
6. Write final `result.json` following the package contract.

P0:

- StateStore indexes and active queue improvements.
- Append-only goal transcript and reduced goal-file rewrite amplification.

P1:

- Codex output streaming and heartbeat throttling.
- `search_files` hosted performance path using `rg` with Node fallback.
- GitHub sync batching, persisted issue mappings, and terminal comment idempotence.

P2:

- Human-readable MCP text summaries while keeping `structuredContent`.
- Diagnostics timing/cache layering.
- Perf smoke tests and developer workflow scripts.
