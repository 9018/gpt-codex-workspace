# GPTChat Acceptance Flow

> Documents the external acceptance loop: how Codex task artifacts are packaged into a
> reviewable bundle, submitted to GPTChat for acceptance review, and how the response
> is ingested back into the task/goal system.

**Status:** Current
**Last reviewed:** 2026-07-10

---

## 1. Overview

The GPTChat acceptance flow bridges Codex automation with human/GPTChat review.
It is the **external acceptance loop** that runs after the internal acceptance
loop (gate, contract verification, closure decider) produces a result.

### Flow Diagram

```
Codex Task Complete
       |
       v
[1. Build Acceptance Bundle]
       |   - Collect result.json, verification, reports
       |   - Package into structured zip
       |   - Generate human-readable summary
       v
[2. Create GPTChat Request]
       |   - Build structured acceptance prompt
       |   - Include bundle reference
       |   - Set task_id for response routing
       v
[3. GPTChat Reviews Bundle]
       |   - Downloads/inspects acceptance-bundle.zip
       |   - Reviews task-summary.md
       |   - Runs any manual verification steps
       |   - Provides structured response
       v
[4. Ingest GPTChat Response]
       |   - Parse structured response (JSON)
       |   - If ACCEPTED: mark task complete
       |   - If REJECTED: create repair goal
       |   - If CHANGES_REQUESTED: create follow-ups
       v
[5. Update Task/Goal State]
       |   - Write acceptance record to result.json
       |   - Update task status
       |   - Deduplicate repair goals
       v
[Continue / Replan / Stop]
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Bundle Builder | `backend/src/gptchat-acceptance/bundle-builder.mjs` | Creates structured zip from task artifacts |
| Prompt Templates | `backend/src/gptchat-acceptance/prompt-templates.mjs` | Builds acceptance review, optimization, and failure analysis prompts |
| Response Ingestor | `backend/src/gptchat-acceptance/response-ingestor.mjs` | Parses GPTChat responses, creates repair goals |
| Orchestrator | `backend/src/gptchat-acceptance-flow.mjs` | Runs the full submit-accept-ingest flow |
| CLI Wrapper | `scripts/acceptance-workflow.sh` | Shell entry point for the flow |

---

## 2. Acceptance Bundle

The acceptance bundle is a portable zip file containing all artifacts needed for
GPTChat to evaluate the task result.

### Bundle Structure

```
acceptance-bundle/
  manifest.json              -- Bundle metadata + file inventory
  task-summary.md            -- Human-readable task summary
  result.json                -- Raw task result
  verification.json          -- Verification report
  acceptance.contract.json   -- Acceptance contract
  acceptance.json            -- Acceptance gate output (if present)
  acceptance.evidence.json   -- Standardized evidence (if present)
  acceptance-bundle.compact.json  -- Pre-compacted bundle data
  changed/                   -- Copies of all changed files
  report-*.{json,md,txt}     -- Report artifacts from evidence paths
```

### Bundle Location

By default, bundles are created at:
`.gptwork/goals/<goal_id>/acceptance-bundle.zip`

## 3. GPTChat Acceptance Request

After creating the bundle, the orchestrator creates a ChatGPT coordination request
with a structured prompt that includes:

- Task overview (title, ID, goal ID, status, operation kind)
- Result summary from Codex
- Acceptance criteria (from contract blocking requirements)
- Changed files list
- Verification results (passed, exit codes, findings)
- Contract verification status
- Existing blockers and missing evidence
- Bundle reference path
- Decision format (structured JSON response template)

### Prompt Template

The acceptance prompt is built by `prompt-templates.mjs:buildAcceptancePrompt()`.

### Optimization Pack

For tasks that need deeper review, the optimization prompt
(`buildOptimizationPrompt()`) includes the original user request, goal
instructions, and a compact artifact summary alongside the bundle.

### Creating an Acceptance Request

```bash
./scripts/acceptance-workflow.sh submit --task-id <task_id>
```

This creates the bundle, generates the prompt, and calls
`create_chatgpt_request` to queue it for GPTChat attention.

---

## 4. GPTChat Response Ingestion

After GPTChat reviews the bundle and provides a response, the response ingestor
processes it.

### Expected Response Format

GPTChat should respond with structured JSON:

```json
{
  "decision": "accepted|rejected|changes_requested",
  "summary": "Brief human-readable summary of your decision",
  "findings": [
    {
      "severity": "blocker|major|minor|followup",
      "code": "machine_readable_code",
      "message": "Human-readable description",
      "source": "gptchat_acceptance"
    }
  ],
  "repair_instructions": "If rejected, specific instructions for what to fix",
  "followups": ["Optional follow-up task suggestions"]
}
```

The decision must be one of:
- `accepted` — All criteria satisfied. Task can complete.
- `rejected` — Blocking issues remain. Creates a repair goal.
- `changes_requested` — Non-blocking improvements. Creates follow-ups.

### Free-text Fallback

If the response is not valid JSON, the ingestor uses a heuristic parser
(`parseFreeTextDecision()`) that checks for keywords like "accept",
"reject", and "change" in the response text.

### Ingesting a Response

```bash
# Save GPTChat's response to a file
echo '{"decision":"accepted","summary":"Looks good!"}' > /tmp/acceptance-response.json

# Ingest via CLI
./scripts/acceptance-workflow.sh ingest --task-id <task_id> --response-file /tmp/acceptance-response.json

# Auto mode (submit + ingest in one step)
./scripts/acceptance-workflow.sh auto --task-id <task_id> --response-file /tmp/acceptance-response.json
```

### Decision Handling

| Decision | Action | Task Status Change |
|----------|--------|-------------------|
| accepted | Record acceptance, mark task complete | waiting_for_review -> completed |
| rejected | Create repair goal with full context | waiting_for_review -> waiting_for_repair |
| changes_requested | Create follow-up tasks, mark repairable | waiting_for_review -> waiting_for_repair |

---

## 5. Repair Goal Creation (Rejection)

When GPTChat rejects a task, the response ingestor creates a repair goal
using the existing `scheduleRepairAttempt()` from `repair-loop.mjs`.

### Repair Context Preservation

The repair goal includes:
- Original task ID and goal ID
- GPTChat findings with severity levels
- GPTChat repair instructions
- Previous attempt summaries
- Acceptance bundle compact data for context

### Deduplication

The `checkAcceptanceDeduplication()` function prevents creating duplicate
repair goals for the same task + decision + findings combination:

- Builds a dedup key: `gptchat_accept:<task_id>:<decision>:<sorted_finding_codes>`
- Checks existing goals for matching keys
- If a duplicate exists, skips repair creation and logs a warning

### Repair Budget

Repair attempts from GPTChat rejection follow the same budget rules as
internal acceptance failures. The default is 2 attempts, configurable via
`GPTWORK_MAX_REPAIR_ATTEMPTS` environment variable.

---

## 6. Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| GPTWORK_MAX_REPAIR_ATTEMPTS | 2 | Maximum repair attempts for rejected tasks |
| GPTWORK_ACCEPTANCE_BUNDLE_MAX_BYTES | 26214400 (25MB) | Max bundle size |

### Dependencies

- Node.js 18+ with ES module support
- Python 3 (for zip creation fallback)
- Backend state store (file-based or in-memory)

---

## 7. Error Handling

### Bundle Creation Failures

- If core artifacts (result.json, verification.json) are missing, the bundle is
  still created with available files. A warning is added to `manifest.json`.
- If the zip is too large (>25MB), an error is returned. Use smaller changed
  file sets or exclude large binary files.

### Response Parsing Failures

- If GPTChat response is not parseable, the ingestor returns `decision: unknown`
  and records the raw response. The task stays in `waiting_for_review`.
- The free-text fallback handles simple keyword-based decisions.

### Repair Creation Failures

- If `scheduleRepairAttempt()` fails, the response is still ingested but the
  repair goal is not created. A warning is returned and the task remains in
  `waiting_for_review`.

---

## 8. Verification / Testing

### Manual End-to-End Test

```bash
# 1. Build a bundle from a completed task
./scripts/acceptance-workflow.sh bundle --task-id task_abc123

# 2. Inspect the bundle
unzip -l .gptwork/goals/goal_def456/acceptance-bundle.zip
unzip -p .gptwork/goals/goal_def456/acceptance-bundle.zip task-summary.md

# 3. Submit for GPTChat acceptance
./scripts/acceptance-workflow.sh submit --task-id task_abc123

# 4. Simulate GPTChat response (for testing)
echo '{"decision":"accepted","summary":"All checks pass"}' > /tmp/test-accept.json
./scripts/acceptance-workflow.sh ingest --task-id task_abc123 --response-file /tmp/test-accept.json

# 5. Verify the result
cat .gptwork/goals/goal_def456/result.json | python3 -m json.tool
```

---

## 9. Integration with Internal Acceptance Loop

The GPTChat acceptance flow is designed to complement, not replace, the
internal acceptance loop.

### When to Use GPTChat Acceptance

1. **After internal acceptance gate produces `needs_action`** — When the contract
   verifier finds issues that need human judgment.
2. **For high-risk changes** — Config changes, deployment, data migration.
3. **When `review_policy.requires_review_when` conditions are met** — Semantic
   ambiguity, low confidence.
4. **Explicit user request** — User calls `create_chatgpt_request` or
   `submit_for_gptchat_acceptance`.

### When Internal Acceptance is Sufficient

1. **code_change with clean verification** — All checks pass, no ambiguity.
2. **noop/diagnostic tasks** — No changes to verify.
3. **docs_only tasks** — Low-risk changes.

### Relationship with Task Finalizer States

| Task Status | Internal Acceptance | GPTChat Acceptance |
|-------------|-------------------|-------------------|
| completed | Auto-completed via gate | Not needed |
| waiting_for_repair | Internal repair loop | GPTChat can provide reprioritized instructions |
| waiting_for_review | Upgrade to human | **Primary use case**: GPTChat reviews and decides |
| waiting_for_integration | Integration queue | GPTChat can verify integration if needed |

---

## 10. Artifact Summary

| Artifact | Path | Format | Purpose |
|----------|------|--------|---------|
| Acceptance Bundle Zip | `.gptwork/goals/<goal_id>/acceptance-bundle.zip` | Zip | Portable artifact set for GPTChat download |
| Bundle Manifest | Inside zip: `acceptance-bundle/manifest.json` | JSON | Bundle metadata + file inventory |
| Task Summary | Inside zip: `acceptance-bundle/task-summary.md` | Markdown | Human-readable overview |
| Compact Bundle Data | Inside zip: `acceptance-bundle/acceptance-bundle.compact.json` | JSON | Pre-compacted structured data |
| GPTChat Acceptance Record | `.gptwork/goals/<goal_id>/result.json["gptchat_acceptance"]` | JSON (inline) | Structured acceptance decision |
| Repair Goal | `.gptwork/goals/repair_<root>_<attempt>/` | Directory | Auto-created repair goal on rejection |

---

## Related Documentation

| Document | Content |
|----------|---------|
| [Closure and Acceptance Model](closure-acceptance.md) | Internal acceptance gate, contract verification |
| [E2E Delivery Workflow](e2e-acceptance.md) | Full delivery pipeline |
| [Acceptance and Repair Contract](delivery/acceptance-and-repair-contract.md) | Profiles, evidence, repair loop |
| [User Delivery Flow](delivery/user-delivery-flow.md) | End-to-end user journey |
| [ChatGPT Prompting Guide](chatgpt-prompting-guide.md) | How GPTChat creates encoded goals |

---

## 2026-07-10 ChatGPT Direct Fix Notes

ChatGPT performed a direct stabilization pass on the GPTChat acceptance flow before creating any new Codex task.

### Fixes

- `response-ingestor.mjs` now imports path utilities from `node:path`, avoiding the ESM load failure caused by importing `dirname` from `node:fs`.
- Acceptance records are written through `goalWorkspaceFiles()` plus the resolved workspace root, instead of a hard-coded repository path.
- `bundle-builder.mjs` resolves the goal directory from the workspace root and prefers canonical/default repo paths when copying changed files.
- Added `backend/test/gptchat-acceptance-response-ingestor.test.mjs` to cover fenced JSON parsing and portable `result.json` acceptance writeback.

### Verification Evidence

```bash
npm_check_syntax
# passed: backend/src node --check all .mjs files

npm_check_imports
# passed: imports ok
```

### Runtime State Note

On 2026-07-10 05:37:39 +08:00, `worker_status` still reported `worker.running=true`, but process evidence showed no matching `codex-worker`, `worker-loop`, `gptwork`, or `node .*worker` process. Treat that UI state as stale/false-positive running status; use heartbeat/process evidence before assuming a worker is active.
