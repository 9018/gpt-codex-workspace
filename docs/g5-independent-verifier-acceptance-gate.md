# G5: Independent Verifier & Acceptance Gate Engine

## Purpose

G5 provides a unified, independent verification and acceptance workflow that
works alongside the existing task lifecycle but is not tightly coupled to it.
It enables:

1. **Independent verification** — Verify task results outside the main execution
   loop, from scripts, tools, or automated pipelines.
2. **Three-way acceptance judgment** — Clearly distinguish between
   **accepted (通过)**, **failed (未通过)**, and **needs_continue (需继续处理)**.
3. **File-based artifacts** — Produce standardized `verification.json` and
   `acceptance.json` files that can be read by other tools and processes.
4. **Backward compatibility** — All existing modules (`task-verifier.mjs`,
   `acceptance-gate-engine.mjs`, `task-acceptance.mjs`) continue working unchanged.

## Architecture

```
┌─────────────────────┐
│  result.json        │  Input: task result from execution
│  acceptance.contract │  Input: optional acceptance contract
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Independent Verifier │  verification-result-file.mjs
│ (independent-        │  - Create/write/read/validate
│  verifier.mjs)       │  - Schema: gptwork.verification_result.v1
└─────────┬───────────┘
          │
          ▼  verification.json
┌─────────────────────┐
│ Acceptance Judgment  │  acceptance-judgment.mjs
│ (acceptance-         │  - Three-way judgment logic
│  judgment.mjs)       │  - accepted / failed / needs_continue
└─────────┬───────────┘
          │
          ▼  acceptance.json
┌─────────────────────┐
│ Gate Orchestrator    │  acceptance-gate-orchestrator.mjs
│ (acceptance-gate-    │  - Ties verification + judgment together
│  orchestrator.mjs)   │  - Manages artifact lifecycle
└─────────────────────┘
```

## Module Reference

### 1. `verification-result-file.mjs`

Schema and I/O for verification result files.

| Export | Description |
|---|---|
| `createVerificationResult(options)` | Create structured verification result |
| `writeVerificationResultFile(path, result)` | Write to JSON file |
| `readVerificationResultFile(path)` | Read and validate from JSON file |
| `checkVerificationResultFile(path)` | Check file existence and validity |
| `VERIFICATION_RESULT_SCHEMA_VERSION` | `"gptwork.verification_result.v1"` |
| `VALID_JUDGMENTS` | `Set{"passed", "failed", "needs_continue"}` |

**Verification result schema:**

```json
{
  "schema_version": "gptwork.verification_result.v1",
  "judgment": "passed|failed|needs_continue",
  "passed": true,
  "needs_continue": false,
  "failed": false,
  "timestamp": "2026-07-02T00:00:00.000Z",
  "task_id": "task_id",
  "goal_id": "goal_id",
  "commands": [{ "cmd": "npm test", "exit_code": 0, "stdout_tail": "", "stderr_tail": "" }],
  "findings": [{ "severity": "blocker|warning|info|followup", "code": "...", "message": "...", "source": "..." }],
  "changed_files": ["..."],
  "skipped_checks": [{ "cmd": "...", "reason": "..." }],
  "reason_no_tests": null,
  "contract_verification": null,
  "metadata": {},
  "summary": "All verification checks passed."
}
```

### 2. `independent-verifier.mjs`

Independent verification runner that can work outside the task lifecycle.

| Export | Description |
|---|---|
| `runIndependentVerification(options)` | Main entry point |
| `verifyFromFile(path, options)` | Convenience: verify from result.json path |

**Options:**

- `result` — Parsed result object
- `resultJsonPath` — Path to result.json
- `goal` — Goal object (for contract/metadata)
- `task` — Task object
- `repoPath` — Git repo path for evidence collection
- `verificationCommands` — Explicit commands to run
- `runCommand` — Custom command runner function
- `config` — Configuration overrides (e.g., `now`, `verificationCommandTimeout`)
- `writeResultFile` — Write verification.json (default: true)
- `outputDir` — Custom output directory

**Returns:**

```json
{
  "judgment": "passed|failed|needs_continue",
  "passed": true,
  "needs_continue": false,
  "failed": false,
  "verification": { "... verification result ..." },
  "result_file_path": "/path/to/verification.json"
}
```

### 3. `acceptance-judgment.mjs`

Three-way acceptance judgment module.

| Export | Description |
|---|---|
| `judgeAcceptance(options)` | Make acceptance judgment |
| `mapJudgmentToTaskStatus(judgment)` | Map to task status string |
| `judgmentAllowsAutoComplete(judgment)` | Check if auto-complete is allowed |
| `ACCEPTANCE_JUDGMENT_SCHEMA_VERSION` | `"gptwork.acceptance_judgment.v1"` |
| `VALID_JUDGMENTS` | `["accepted", "failed", "needs_continue"]` |

**Judgment logic:**

| Condition | Judgment |
|---|---|
| Verification = passed AND result = completed | **accepted (通过)** |
| Verification = failed OR result = failed OR blockers exist | **failed (未通过)** |
| Verification = needs_continue OR command failures without blockers OR result not completed | **needs_continue (需继续处理)** |

### 4. `acceptance-result-file.mjs`

Schema and I/O for acceptance result files.

| Export | Description |
|---|---|
| `createAcceptanceResult(options)` | Create structured acceptance result |
| `writeAcceptanceResultFile(path, result)` | Write to JSON file |
| `readAcceptanceResultFile(path)` | Read and validate from JSON file |
| `checkAcceptanceResultFile(path)` | Check file existence and validity |
| `ACCEPTANCE_RESULT_SCHEMA_VERSION` | `"gptwork.acceptance_result.v1"` |

### 5. `acceptance-gate-orchestrator.mjs`

Combines verification + judgment into a complete gate flow.

| Export | Description |
|---|---|
| `runIndependentGate(options)` | Main entry point |
| `gateFromFile(path, options)` | Convenience: gate from result.json path |
| `gateWithVerification(options)` | Convenience: gate with pre-computed verification |
| `gateWithCommands(options)` | Convenience: gate with explicit verification commands |

## Usage Examples

### Standalone verification from file:

```javascript
import { verifyFromFile } from "./src/independent-verifier.mjs";

const result = await verifyFromFile("/path/to/result.json", {
  repoPath: "/path/to/repo",
  verificationCommands: ["npm test", "npm run lint"],
});
console.log(result.judgment); // "passed" | "failed" | "needs_continue"
```

### Full acceptance gate:

```javascript
import { runIndependentGate } from "./src/acceptance-gate-orchestrator.mjs";

const gate = await runIndependentGate({
  resultJsonPath: "/path/to/goal/dir/result.json",
  goal: { id: "goal_123" },
  task: { id: "task_456" },
  repoPath: "/path/to/repo",
  writeArtifacts: true,
});

console.log(gate.judgment); // "accepted" | "failed" | "needs_continue"
console.log(gate.artifacts.acceptance_json); // "/path/to/goal/dir/acceptance.json"
```

### With pre-computed verification:

```javascript
import { gateWithVerification } from "./src/acceptance-gate-orchestrator.mjs";

const gate = await gateWithVerification({
  verification: previousVerificationResult,
  result: { status: "completed", summary: "Done" },
});
```

## Backward Compatibility

G5 modules are additive. All existing modules continue to work:

- `acceptance-gate-engine.mjs` — Unchanged, uses `task-verifier.mjs` internally
- `task-verifier.mjs` — Unchanged, task-lifecycle-integrated verification
- `task-acceptance.mjs` — Unchanged, existing acceptance workflow
- `verification-report.mjs` — Unchanged, report reuse utilities
- `verification-evidence.mjs` — Unchanged, evidence collection

The new modules produce the same artifact filenames (`verification.json`,
`acceptance.json`) in the same locations, so downstream consumers do not
need to change.

## Test Coverage

| Test File | Scenarios Covered |
|---|---|
| `test/verification-result-file.test.mjs` | All three judgments, write/read, validation, file checks |
| `test/independent-verifier.test.mjs` | Passed/failed/needs_continue, file-based input, artifacts |
| `test/acceptance-judgment.test.mjs` | 通过/未通过/需继续处理, mapping, auto-complete, edge cases |
| `test/acceptance-result-file.test.mjs` | All three judgments, write/read, validation, file checks |
| `test/acceptance-gate-orchestrator.test.mjs` | Gate flow, pre-computed verification, file entry, artifact writing |

## Dependency: G4 Context Curator

G5 depends on G4 for context curator manifest paths that help discover
goal workspace directories and their files (result.json, contract files).
The `independent-verifier.mjs` uses G4's `context.manifest.json` file paths
to locate verification artifacts within goal directories.

## Schema Versions

| Artifact | Schema |
|---|---|
| Verification result | `gptwork.verification_result.v1` |
| Acceptance judgment | `gptwork.acceptance_judgment.v1` |
| Acceptance result | `gptwork.acceptance_result.v1` |
