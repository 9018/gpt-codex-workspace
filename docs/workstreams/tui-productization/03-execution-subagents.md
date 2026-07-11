# G3: Execution 与 Subagent 结构化进度

**Status:** Implemented + Verified
**Workstream:** ws_gptwork_tui_productization_20260711
**Root Goal:** goal_48d055ee-82b6-415b-8d98-65cb7662aaaf
**Depends on:** G1, G2

## Summary

Previously, ChatGPT and controllers could only monitor execution progress by
parsing ANSI TUI screen output — fragile, error-prone, and non-structured.

**G3 fixes this** by introducing a structured subagent progress system:

1. **Fixed parent TUI pipeline** with defined phases, parallel agent groups, and max repair rounds.
2. **Atomic progress files** (`progress.json` and `subagents.json`) written to `.gptwork/goals/<goal_id>/`.
3. **MCP tools** (`codex_tui_progress`, `codex_tui_subagents`) that return structured data without ANSI parsing.
4. **Result normalizer** that converts raw subagent output to consistent shapes.

## Architecture

### Parent TUI Pipeline (Fixed)

```
context_curator (phase 0)
  → [explorer | architect | test_analyst] (phase 1, parallel)
    → planner (phase 2)
      → builder (phase 3)
        → verifier (phase 4)
          → reviewer (phase 5)
            → repairer (phase 6, ≤ 2 rounds)
              → finalizer (phase 7)
```

| Phase | Name | Agents | Parallel | Max Rounds |
|-------|------|--------|----------|------------|
| 0 | Context Curation | context_curator | no | 1 |
| 1 | Analysis | explorer, architect, test_analyst | **yes** | 1 |
| 2 | Planning | planner | no | 1 |
| 3 | Building | builder | no | 1 |
| 4 | Verification | verifier | no | 1 |
| 5 | Review | reviewer | no | 1 |
| 6 | Repair | repairer | no | 2 |
| 7 | Finalization | finalizer | no | 1 |

### Progress File Structure

#### progress.json

Written atomically to `.gptwork/goals/<goal_id>/progress.json`:

```json
{
  "goal_id": "goal_abc123",
  "phase": "building",
  "status": "running",
  "current_action": "Implementing core API endpoints",
  "blockers": [],
  "next_expected_event": "verification",
  "last_progress_at": "2026-07-11T08:30:00.000Z",
  "subagents": [
    {
      "role": "context_curator",
      "round": 1,
      "phase": "context_curation",
      "status": "completed",
      "summary": "Gathered task context from project files",
      "changed_files": [],
      "artifacts": ["context.bundle.md"],
      "blockers": [],
      "started_at": "2026-07-11T08:00:00.000Z",
      "completed_at": "2026-07-11T08:05:00.000Z"
    },
    {
      "role": "explorer",
      "round": 1,
      "phase": "analysis",
      "status": "completed",
      "summary": "Explored repository structure",
      "changed_files": [],
      "artifacts": ["exploration-report.md"],
      "blockers": [],
      "started_at": "2026-07-11T08:05:00.000Z",
      "completed_at": "2026-07-11T08:10:00.000Z"
    }
  ]
}
```

#### subagents.json

Written atomically to `.gptwork/goals/<goal_id>/subagents.json`:

```json
[
  {
    "role": "builder",
    "round": 1,
    "phase": "building",
    "status": "completed",
    "summary": "Implemented API endpoints",
    "changed_files": ["src/api.ts", "src/routes.ts"],
    "artifacts": ["dist/bundle.js"],
    "blockers": [],
    "started_at": "2026-07-11T08:15:00.000Z",
    "completed_at": "2026-07-11T08:45:00.000Z"
  }
]
```

### MCP Tools (No ANSI Parsing)

Two new MCP tools replace screen-scraping:

| Tool | Purpose | Key Fields |
|------|---------|------------|
| `codex_tui_progress` | Read structured pipeline progress | goal_id, phase, status, current_action, blockers, next_expected_event, last_progress_at, subagents |
| `codex_tui_subagents` | Read structured subagent results | goal_id, subagents[{role, status, summary, changed_files, artifacts, blockers}] |

Both tools require only a `goal_id` and return pure JSON — no ANSI parsing needed.

## Files

### New Files

| File | Purpose |
|------|---------|
| `backend/src/subagents/subagent-policy.mjs` | Parent TUI pipeline phase definitions, role-to-phase mapping, default skeleton builder |
| `backend/src/subagents/subagent-progress-store.mjs` | Atomic progress.json and subagents.json writer with merge semantics |
| `backend/src/subagents/subagent-result-normalizer.mjs` | Normalizes subagent results, infers pipeline status/phase/blockers/next event |

### Modified Files

| File | Change |
|------|--------|
| `backend/src/codex-tui-goal-prompt.mjs` | Added `buildPipelinePhaseInstruction()` — embeds pipeline phases, progress file paths, and MCP tool references into goal objectives and follow-up instructions |
| `backend/src/codex-tui-session-store.mjs` | Added `writeGoalProgress()`, `readGoalProgress()`, `writeGoalSubagents()`, `readGoalSubagents()` — atomic progress file I/O |
| `backend/src/tool-groups/codex-tui-tools-group.mjs` | Added `codex_tui_progress` and `codex_tui_subagents` tools returning structured data; imports `createCodexTuiSessionStore` for progress reads |
| `backend/src/agent-run-service.mjs` | Added `buildProgressFromAgentRuns()` and `writeGoalSubagentProgress()` — build progress payloads from agent runs and persist them |

### Test Files

| File | Purpose |
|------|---------|
| `backend/test/subagent-policy-pipeline.test.mjs` | 14 tests for phase definitions, role mapping, skeleton generation |
| `backend/test/subagent-progress-store.test.mjs` | 10 tests for atomic writes, merges, reads, and payload building |
| `backend/test/subagent-result-normalizer.test.mjs` | 14 tests for normalization, dedup, status inference, phase detection |

## Behavior

### Progress Write Atomicity

- All writes use a temporary file + rename pattern: `file.json.<uuid>.tmp` → `file.json`
- Merges with existing data: writes only update the fields provided
- Subagents are merged by `(role, round)` key for deduplication

### Status Inference

`inferPipelineStatus()` determines overall pipeline state:

| Condition | Status |
|-----------|--------|
| Any agent blocked | `blocked` |
| Non-repair agent failed | `failed` |
| Any agent running | `running` |
| All agents completed | `completed` |
| Otherwise | `running` |

### Phase Detection

`inferCurrentPhase()` finds the active phase:
1. First agent with `status="running"` → its phase
2. First agent with `status="pending"` → its phase
3. Last agent's phase
4. Fallback: `context_curation`

### Goal Prompt Changes

`buildCodexTuiGoalObjective()` now optionally includes:
- The full pipeline phase listing
- Progress file paths (`progress.json`, `subagents.json`)
- MCP tool references (`codex_tui_progress`, `codex_tui_subagents`)
- Required subagent result fields (role, status, summary, changed_files, artifacts, blockers)

`buildCodexTuiFollowupInstruction()` references progress files and MCP tools.

## Verification

| Check | Result |
|-------|--------|
| `subagent-policy-pipeline.test.mjs` — 14 tests | 14/14 pass |
| `subagent-progress-store.test.mjs` — 10 tests | 10/10 pass |
| `subagent-result-normalizer.test.mjs` — 14 tests | 14/14 pass |
| `codex-tui-goal-prompt.test.mjs` — 4 tests | 4/4 pass |
| `codex-tui-session-store.test.mjs` — 3 tests | 3/3 pass |
| `codex-tui-tools-group.test.mjs` — 8 tests | 8/8 pass |
| `subagent-policy.test.mjs` — 26 tests | 26/26 pass |
| `agent-run-service.test.mjs` — existing tests | pass |
| Atomic write uses tmp+rename pattern | Verified |
| Merge semantics preserve role+round de-duplication | Verified |
| No ANSI parsing dependency | Verified (all data from JSON files) |

## Migration Notes

- Existing session records continue to work unchanged.
- MCP tool consumers can now use `codex_tui_progress` and `codex_tui_subagents` instead of screen scraping.
- Goal prompts now include pipeline phase instructions; existing sessions will pick this up automatically on follow-up.
- The `includePipeline` option (default: `true`) controls whether pipeline instructions appear in goal objectives.
