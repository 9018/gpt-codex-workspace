# GPTWork Context Layer

## Overview

GPTWork organizes execution context into a layered system designed to give Codex
the minimal information needed for each task, while keeping deep, expensive
context available only when explicitly needed.

The context layer is built around three principles:

1. **Entry-first**: Codex always starts from a small, bounded entrypoint
   (codex.entry.md), not from the full goal/transcript.
2. **Degrade cleanly**: When a context component is unavailable, the system
   describes the degradation explicitly in the Codex prompt so Codex can adapt,
   rather than failing silently or defaulting to full deep context.
3. **Prioritize facts over indexes**: Durable files (git, result, diagnostics)
   are authoritative. Vector/retrieval indexes are rebuildable caches, not
   sources of truth.

---

## Layer Hierarchy

```
   Tier 1: Bounded entry (always available)
   ─────────────────────────────────────────
   codex.entry.md          Required. The smallest file Codex should read first.
                           Contains task title, goal context lookup policy, and
                           result contract.

   Tier 2: Compact context (preferred)
   ─────────────────────────────────────────
   context.bundle.md       Optional. Auto-generated summary from retrieved
                           chunks. Preferred over full transcript for initial
                           context. When missing, Codex degrades to entry-only.

   context.manifest.json   Diagnostics only. Declares which context artifacts are
                           present and their roles. Not primary execution context.

   Tier 3: Deep lookup (only when tier 1+2 insufficient)
   ─────────────────────────────────────────
   goal.md                 Full goal specification, user request, memories.
   context.json            Metadata: workspace files, codex_instruction.
   transcript.md           Full conversation history.

   Tier 4: Evidence (authoritative facts)
   ─────────────────────────────────────────
   result.json / result.md Task result with verification evidence (read by
                           GPTWork before next context build).
   acceptance.contract.json  Acceptance criteria, verification plan, and
                           blocking requirements for the goal/task.
   artifact.contract.json    Artifact-level contract for review/acceptance
                           evidence mapping.
   git status/diff         Current repository state.
```

---

## File Roles

### codex.entry.md (Bounded Entrypoint)

The only file Codex is instructed to read before making its first tool call.
Contains:

- Task title and goal ID
- Goal prompt and context summary (brief)
- Context lookup policy (which files to read and when)
- Result contract and result JSON schema
- Execution rules (edit only under execution repo path, write results)

The entrypoint is referenced three ways:
- **Codex prompt** (codex-prompt-builder.mjs): The full prompt tells Codex
  "Start by reading only this bounded entrypoint" and lists the entry path.
- **Codex TUI** (codex-tui-goal-prompt.mjs): The `/goal` instruction and
  follow-up messages tell the TUI agent to "read codex.entry.md first."
- **goal.md workspace files**: The goal.md itself references the entry and
  the bundle as preferred context.

Generation: `renderCodexEntryMarkdown()` in `goal-files.mjs`.

### context.bundle.md (Context Bundle)

Auto-generated summarization of retrieved chunks relevant to the current goal.
Contains:

- Retrieval metadata (chunk types, scores, bucket quotas, score range)
- Selected context summary (highest-scored goal chunk or goal.context_summary)
- Relevant prior conversations (excerpts with similarity scores)
- Relevant prior task results
- Constraints and acceptance hints (execution mode, autonomy policy, decision rule)
- Omitted transcript note (pointing to transcript.md for full history)
- Retrieval sources (per-chunk source type, goal ID, score, selection metadata)

Building uses a **two-phase retrieval** strategy:
1. **Cross-goal retrieval**: Searches all indexed goals in the workspace for
   related context without a goal_id filter. Supports cross-goal awareness.
2. **Per-goal retrieval**: Searches the current goal's index for precision.
   Current-goal chunks are prioritized.

Chunks are scored, boosted by evidence type (accepted_result, repair_result,
integration_result) with stale/noop penalty, and selected within quota buckets
(currentGoalMin, resultMax, conversationMax) up to a token budget. The bundle
is capped at configurable max tokens (default 2048) and max chunks (default 8).

Generation: `buildContextBundle()` in `context-bundle-builder.mjs`.
Two-phase retrieval orchestration: `maybeBuildContextBundle()` in
`context-index-hooks.mjs`.

### context.retrieval.json (Retrieval Diagnostics)

Records the retrieval process — what was searched, what was found, and why
chunks were selected. Contains cross-goal and per-goal retrieval results with
per-chunk details.

Diagnostic modes (as reported by diagnostics-context-status.mjs):

- **diagnostic_with_chunks**: Normal operation. Chunks were found and used
  in the bundle. The file serves as diagnostic evidence.
- **diagnostic_only**: Retrieval ran but found 0 chunks. The file serves only
  as diagnostic evidence; Codex must rely on durable sources.
- **invalid**: File exists but cannot be parsed as valid JSON.
- **missing**: No retrieval was attempted or the file was never written.

Context bundle generation writes both context.bundle.md and
context.retrieval.json atomically. When retrieval produces no chunks, only
the retrieval JSON is written (no bundle), and the system degrades to
durable-only context.

Generation: `maybeBuildContextBundle()` in `context-index-hooks.mjs`.

### context.manifest.json (Artifact Map)

Declares which context artifacts exist and their roles. Used for diagnostics
and context hygiene validation, not as primary task context.

A complete manifest requires:

- **schema_version**: Current version (`1`).
- **entrypoint**: The bounded entrypoint file path.
- **default_context_package**: Array of default context files to provide
  (e.g. `["codex.entry.md", "context.bundle.md"]`).
- **artifacts**: Object with required artifacts (`codex_entry`), optional
  artifacts, each with a `present` boolean and optional `required` override.
- **lookup_policy**: Object with `default_read_order` array specifying the
  preferred file read sequence.

Generation: `buildContextManifest()` in `context-curator.mjs`.

### goal.md (Full Goal Specification)

Complete goal specification including user request, goal prompt, autonomy policy,
memories, workspace files, subagent policy, and execution contract. Only read
when the entry and bundle are insufficient.

### transcript.md (Conversation History)

Complete conversation transcript. Only read when the bundle does not provide
enough context for the current task. A warning is emitted when transcript
size exceeds 100 KB.

### acceptance.contract.json

Defines acceptance criteria for the goal/task. Contains:
- **intent**: Operation kind, mutation scope, execution mode.
- **blocking_requirements**: Requirements that block closure (commit_present,
  changed_files_reported, verification_report, integration_completed).
- **verification_plan**: Required reports, verification profile.
- **non_blocking_quality_expectations**: Quality concerns that should be
  reported as followups rather than blocking completion.
- **completion_policy**: When to auto-complete, whether to allow followups.

### artifact.contract.json

Maps artifact-level contracts for review and acceptance evidence. Used by
the agent-artifact-contract module to validate that task results include
the required evidence (result.json fields, changed_files, commit hash,
verification evidence).

---

## Context Source Precedence

Codex processes context from multiple sources in a defined precedence order.
This list is reported by the `project_context_status` / `context_status` tools:

| Rank | Source | Description |
|------|--------|-------------|
| 1 | task.description / task fields | Direct task metadata from the task object |
| 2 | linked goal prompt/context files | goal.md and context.json from the linked goal workspace files |
| 3 | project.md / project.env | Project-level context files under canonical repo `.gptwork/` |
| 4 | durable goal transcript/memories | Transcript and memory items from goal conversation history |
| 5 | runtime defaults / repo registry | Workspace root, state path, exec timeout, registered repo metadata |

### project.md and project.env

Both live under the canonical repo's `.gptwork/` directory:

- **project.md**: Free-form Markdown. Purpose, development commands, deployment
  notes. Loaded by `loadProjectMd()` in `codex-context-loaders.mjs`. Emitted
  as a warning when absent.
- **project.env**: Non-secret KEY=VALUE environment variables (one per line,
  `#` comments supported). Loaded by `loadProjectEnv()`. Does NOT mutate
  `process.env` — it is hot-loaded per Codex context build and used only for
  context content.

Safety constraints:
- **No secrets**: project.env must never contain real credentials. Secret-like
  key names (those containing SECRET, KEY, TOKEN, PASSWORD, etc.) are detected
  and reported as redacted key names in diagnostics, but values are never
  exposed in status output.
- **No overwrite**: The `context_prepare` tool (fix_safe mode) creates template
  files when project.md or project.env are missing, but never overwrites
  existing content.

---

## Fact Source Priority

GPTWork establishes a clear hierarchy for what constitutes an authoritative
fact source and what is a rebuildable index:

### Authoritative (Durable) Sources

| Source | Description | Persistence |
|--------|-------------|-------------|
| Durable files: result.json, result.md, goal.md | Written once and remain until overwritten | File system |
| acceptance.contract.json, artifact.contract.json | Acceptance criteria and evidence contracts | File system |
| Git history and status | Immutable history and current worktree state | Git repository |
| Task result/verification evidence | Task result object with verification commands | Internal state |
| Runtime diagnostics | context_status, runtime_status, diagnostics_cache | Generated per-request |

These sources are the canonical record of what happened. They are never
reconstructed from indexes.

### Rebuildable Sources

| Source | Description | Rebuild trigger |
|--------|-------------|-----------------|
| context.bundle.md | Retrieved chunk summary | Goal creation or update |
| context.retrieval.json | Retrieval metadata | Goal creation or update |
| context.manifest.json | Artifact map | Goal creation or update |
| Vector store (zvec/local-json) | Embedding index | Goal indexing |
| chunks.json, vectors.json | Index files under .gptwork/context-index/ | Goal indexing |

These sources are caches. If they are missing or stale, the system falls back
to durable sources. Codex should never treat absence of a retrieval index as
absence of evidence.

---

## Codex Entry Consumption Flow

When Codex starts executing a task, the prompt instructs Codex to consume
context in this exact order:

1. **Read codex.entry.md first**. This is the bounded entrypoint. It contains
   the task, user request, goal prompt, context lookup policy, and result
   contract. Codex must not read any larger goal/state file before reading
   the entry.

2. **Use context.bundle.md as supporting context** when present. The bundle
   contains summarized retrieval evidence including prior conversations and
   results. If absent, Codex degrades to entry-only.

3. **Perform explicit deep lookups** only when the entry + bundle are
   insufficient. The following files are explicitly deep-lookup:
   - goal.md (full goal specification)
   - context.json (metadata only, not wholesale content)
   - transcript.md (conversation history)

4. **Project context files** (project.md, project.env) under the canonical
   repo are optional lookups — Codex is told about them but is not required
   to read them.

This order is encoded in the `buildCodexPrompt()` function, which generates
the full prompt string including context lookup policy and the instruction
"Read codex.entry.md first; deep-read larger goal/state files only when needed."

The **Codex TUI** also enforces entry-first: the `/goal` instruction generated
by `buildCodexTuiGoalObjective()` tells the TUI agent to "Read
codex.entry.md first." Follow-up instructions repeat this directive.

---

## Retrieval and Bundle Building

### Two-Phase Retrieval

Context bundle generation (P0) uses two-phase retrieval:

1. **Cross-goal retrieval**: No goal_id filter. Searches all indexed goals
   in the workspace for related context (results, messages, goals). Controlled
   by `contextCrossGoalTopK` config (default 4).

2. **Per-goal retrieval**: Goal_id filter on current goal. Ensures current
   goal context is always represented. Controlled by `contextPerGoalTopK`
   config (default 4).

Results are merged: current-goal chunks first, cross-goal evidence second,
deterministic current-chunks as fallback. Up to `contextBundleMaxChunks`
(default 8) chunks are included.

### Evidence Boosts

Chunks are boosted by evidence type:

| Condition | Boost |
|-----------|-------|
| Current goal | +0.35 |
| Accepted/successful result | +0.25 |
| Repair/fix result | +0.22 |
| Integration/completed result | +0.20 |
| Any result source | +0.12 |
| Failed/stale/noop result | -0.30 |
| Parent repair chain evidence | +0.18 |

### Context Index Fallback Chain

The index system (`collectContextIndexStatus()` in
`diagnostics-context-status.mjs`) resolves which vector store to use:

- **GPTWORK_CONTEXT_VECTOR_STORE=auto** (default): Try @zvec/zvec; fall back
  to local-json-store if unavailable.
- **GPTWORK_CONTEXT_VECTOR_STORE=zvec**: Require @zvec/zvec; emit warning
  if unavailable.
- **GPTWORK_CONTEXT_VECTOR_STORE=local**: Use local-json-store directly.

When indexing fails for any reason (missing @zvec/zvec, store unavailable,
zero chunks produced), `maybeBuildContextBundle()` returns `{ ok: false,
warning }` and the system degrades gracefully by writing only a diagnostic
context.retrieval.json.

---

## Degradation Paths

The `buildCodexPrompt()` function appends degradation notes to the goal
context block when context components are unavailable.

### Bundle missing

When `context.bundle.md` is missing, the prompt builder appends degradation
notes. The notes are constructed as an array of strings (degradationNotes)
and appended after the standard context lookup policy:

```
**WARNING: context.bundle.md is missing**.
Codex will rely on codex.entry.md and explicit deep-lookup files only.
Reason: [specific reason from diagnostics]
```

Codex is instructed not to silently fall back to reading `goal.md` or
`transcript.md` wholesale. Instead it must use `codex.entry.md` as the
bounded context and perform explicit deep lookups only when truly needed.

### Retrieval unavailable

When `context.retrieval.json` exists but contains no chunks (diagnostic-only),
or is entirely missing, the prompt includes:

```
**WARNING: Context retrieval is unavailable**.
Falling back to durable sources (goal.md, result.json, task fields).
context.retrieval.json exists but contains no retrieved chunks —
it is diagnostic only.
```

Codex should use durable goal/result files instead of depending on retrieval.

### Large transcript

When the transcript exceeds 100 KB, the prompt may warn:

```
**WARNING: Transcript is [size] ([count] messages).**
Do not read transcript.md by default. Rely on context.bundle.md and
codex.entry.md.
```

### Manifest incomplete

When `context.manifest.json` is missing or incomplete (required artifacts
not declared present), diagnostics report the specific issues. The manifest
is not essential for execution — it is a diagnostic aid.

### Project context files missing

When project.md or project.env are absent, the `project_context_status` tool
reports specific warnings:
- "No project.md found under canonical repo. Project-level Markdown context
  will not be loaded."
- "project.env exists but appears empty (no KEY=VALUE pairs found)."

The `context_prepare` tool (mode=fix_safe) can create missing templates but
never overwrites existing content. It refuses to run on a dirty worktree.

---

## Diagnostics

### context_status / project_context_status

The `context_status` and `project_context_status` tools (defined in
`context-health-tools-group.mjs`) return structured health data for each
goal/task. They are aliases: `context_status` responds to natural language
like "上下文状态".

Output includes:

```json
{
  "canonical_repo_path": "...",
  "repo_registered": true,
  "workspace_root": "...",
  "project_context": {
    "project_md_exists": true,
    "project_env_exists": true,
    "project_env_key_count": 5,
    "project_env_secret_like_key_count": 0,
    "redacted_key_names": []
  },
  "context_index": { "configured_store": "auto", "effective_store": "...", ... },
  "context_source_precedence": [ ... ],
  "warnings": [],
  "task": {
    "task_id": "...",
    "task_status": "running",
    "linked_goal_id": "...",
    "preview_available": true,
    "context_health": {
      "codex_entry": "present" | "missing",
      "context_bundle": "present" | "missing" | "degraded_retrieval_only",
      "context_bundle_reason": string | null,
      "context_retrieval": "diagnostic_with_chunks" | "diagnostic_only" | "invalid" | "missing",
      "transcript_bytes": number,
      "transcript_exists": boolean,
      "transcript_warning": "large" | undefined,
      "manifest_exists": boolean,
      "manifest_complete": boolean,
      "review_packet_viable": boolean
    }
  },
  "context_contract": { "status": "ok" | "warnings" | "degraded", "checks": {}, "warnings": [] }
}
```

### context_prepare (Hygiene Fix)

The `context_prepare` tool provides safe auto-fix for context hygiene:

- **check** mode (default): Dry-run. Reports missing .gptwork/, project.md,
  project.env without making changes.
- **fix_safe** mode: Creates missing `.gptwork/` directory, project.md, and
  project.env template files. Never overwrites existing content. Refuses to
  run on dirty worktree to avoid racing with other Codex runs.

### Context Contract Diagnostics (P0-C9)

The `context-contract-diagnostics.mjs` module provides comprehensive
stress-test diagnostics. Checks performed:

1. `checkEntryContext(goalDir)` — codex.entry.md existence
2. `checkContextFiles(goalDir)` — bundle/retrieval/json existence and validity
3. `checkTranscript(goalDir)` — size and message count, huge_risk flag (>100 KB)
4. `checkRetrievalFallback(goalDir, task)` — fallback sources availability
5. `checkRepairContextInheritance(task, goal, goalDir, parentGoalDir)` —
   repair task parent evidence
6. `checkCompactReviewBundle(task, goalDir)` — review packet viability
   without full transcript
7. `checkHelperTools(config)` — @zvec/zvec availability
8. `checkContextIndex(contextIndexStatus)` — vector store health
9. `checkManifestCompleteness(goalDir)` — manifest completeness

Diagnostics return `{ status: "ok" | "warnings" | "degraded", checks: {},
warnings: [...], fallback_sources: [...] }`.

---

## Review and Acceptance Bundles

### Review Packet

The review packet (`getTaskReviewPacket()` in `review-packet-builder.mjs`)
provides a compact assessment without reading the full transcript:

```
task_id, goal_id, title, status
reason_for_review
compact_git_summary (files_changed, insertions, deletions, commit)
changed_files
key_evidence (result_summary, verification, contract_verification,
              closure_decision, run_evidence)
blocking_findings
non_blocking_followups
recommended_next_action
missing_evidence
pipeline_gate (blocked status, reasons)
```

### Acceptance Bundle

The acceptance bundle (`getTaskAcceptanceBundle()` in
`task-acceptance-bundle.mjs`) adds:

```
operation_kind
acceptance_contract_summary
result_summary
no-change-repair evidence (result_kind, cleanup_summary)
```

Neither the review packet nor the acceptance bundle contains the full
transcript or context bundle — they are designed to be self-contained
diagnostic summaries.

A compact review bundle is viable without the full transcript when:
- Result evidence exists (result.json or result.md) AND
- Changed files or verification evidence is available.

If neither is available, the system falls back to loading the full transcript.

---

## Codex TUI Integration

The Codex TUI mode (used in codespace/gptwork-terminal) references the
context layer through `codex-tui-goal-prompt.mjs`:

- `buildCodexTuiGoalObjective()` generates a `/goal` command that includes
  `goal_id=<id>` and instructs the agent to "Read codex.entry.md first."
- `buildCodexTuiFollowupInstruction()` generates follow-up messages that
  repeat the instruction: "Before planning or editing, read codex.entry.md
  and follow its execution contract."
- `buildCodexTuiBootstrapMessages()` returns both the goal objective and
  follow-up instruction as a pair of messages.

This ensures that even in TUI mode, Codex follows the same entry-first
context consumption pattern as the MCP execution mode.
