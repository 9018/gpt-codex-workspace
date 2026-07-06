# GPTWork Context Layer

## Overview

GPTWork organizes execution context into a layered system designed to give Codex
the minimal information needed for each task, while keeping deep, expensive
context available only when explicitly needed.

The context layer is built around three principles:

1. **Entry-first**: Codex always starts from a small, bounded entrypoint
   (codex.entry.md), not from the full goal/transcript.
2. **Degrade cleanly**: When a context component is unavailable, the system
   describes the degradation explicitly so Codex can adapt, rather than failing
   silently or defaulting to full deep context.
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

   context.manifest.json   Diagnostics only. Maps which context artifacts are
                           present. Not intended as primary execution context.

   Tier 3: Deep lookup (only when tier 1+2 insufficient)
   ─────────────────────────────────────────
   goal.md                 Full goal specification, user request, memories.
   context.json            Metadata: workspace files, codex_instruction.
   transcript.md           Full conversation history.

   Tier 4: Evidence (authoritative facts)
   ─────────────────────────────────────────
   result.json / result.md Task result with verification evidence.
   git status/diff         Current repository state.
   acceptance.contract.json  Acceptance criteria and verification plan.
```

---

## File Roles

### codex.entry.md (Bounded Entrypoint)

The only file Codex is instructed to read before making its first tool call.
Contains:

- Task title and goal ID
- Goal prompt and context summary (brief)
- Context lookup policy (which files to read and when)
- Result contract (what to produce)
- Execution rules

Generation: `renderCodexEntryMarkdown()` in `goal-files.mjs`.

### context.bundle.md (Context Bundle)

Auto-generated summarization of retrieved chunks relevant to the current goal.
Contains:

- Retrieval metadata (chunk types, scores, quotas)
- Selected context summary
- Relevant prior conversations (excerpts)
- Relevant prior task results
- Constraints and acceptance hints
- Omitted transcript note

Generation: `buildContextBundle()` in `context-bundle-builder.mjs`.

### context.retrieval.json (Retrieval Diagnostics)

Records the retrieval process — what was searched, what was found, and why
chunks were selected. May be:

- **diagnostic_with_chunks**: Normal operation. Chunks were found and used.
- **diagnostic_only**: Retrieval ran but found no chunks. The file serves only
  as diagnostic evidence; Codex must rely on durable sources.
- **missing**: No retrieval was attempted.

Generation: `maybeBuildContextBundle()` in `context-index-hooks.mjs`.

### context.manifest.json (Artifact Map)

Declares which context artifacts exist and their roles. Used for diagnostics,
not as primary task context.

### goal.md (Full Goal Specification)

Complete goal specification including user request, goal prompt, autonomy policy,
memories, and workspace files. Only read when the entry and bundle are
insufficient.

### transcript.md (Conversation History)

Complete conversation transcript. Only read when bundle does not provide
enough context for the current task.

---

## Fact Source Priority

GPTWork establishes a clear hierarchy for what constitutes an authoritative
fact source and what is a rebuildable index:

### Authoritative (Durable) Sources

| Source | Description | Persistence |
|--------|-------------|-------------|
| Durable files: `result.json`, `result.md`, `goal.md` | Written once and remain until overwritten | File system |
| Git history and status | Immutable history and current worktree state | Git repository |
| Task result/verification evidence | Task result object with verification commands | Internal state |
| Runtime diagnostics | `context_status`, `runtime_status`, `diagnostics_cache` | Generated per-request |

These sources are the canonical record of what happened. They are never
reconstructed from indexes.

### Rebuildable Sources

| Source | Description | Rebuild trigger |
|--------|-------------|-----------------|
| `context.bundle.md` | Retrieved chunk summary | Goal creation or update |
| `context.retrieval.json` | Retrieval metadata | Goal creation or update |
| Vector store (zvec/local-json) | Embedding index | Goal indexing |
| `chunks.json`, `vectors.json` | Index files under `.gptwork/context-index/` | Goal indexing |

These sources are caches. If they are missing or stale, the system falls back
to durable sources. Codex should never treat absence of a retrieval index as
absence of evidence.

---

## Degradation Paths

### Bundle missing

When `context.bundle.md` is missing, the `buildCodexPrompt()` function adds
degradation notes to the Codex prompt:

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

---

## Diagnostics: context_status / project_context_status

The `context_status` and `project_context_status` tools return structured
health data for each goal/task:

```
context_health:
  codex_entry: "present" | "missing"
  context_bundle: "present" | "missing" | "degraded_retrieval_only"
  context_bundle_reason: string | null
  context_retrieval: "diagnostic_with_chunks" | "diagnostic_only" | "invalid" | "missing"
  transcript_bytes: number
  transcript_exists: boolean
  transcript_warning: "large" | undefined
  manifest_exists: boolean
  manifest_complete: boolean
  review_packet_viable: boolean
```

The `context-contract-diagnostics.mjs` module provides comprehensive
diagnostics including:

- `checkEntryContext(goalDir)` — codex.entry.md existence
- `checkContextFiles(goalDir)` — bundle/retrieval/json existence
- `checkTranscript(goalDir)` — size and message count
- `checkRetrievalFallback(goalDir, task)` — fallback sources
- `checkCompactReviewBundle(task, goalDir)` — review packet viability
- `checkManifestCompleteness(goalDir)` — manifest completeness
- `checkRepairContextInheritance(task, goal, goalDir, parentGoalDir)` — repair
  task parent evidence

---

## Review Packet

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

The acceptance bundle (`getTaskAcceptanceBundle()` in
`task-acceptance-bundle.mjs`) adds operation_kind, acceptance_contract_summary,
result_summary, and no-change-repair evidence.

Neither the review packet nor the acceptance bundle contains the full
transcript or context bundle — they are designed to be self-contained
diagnostic summaries.
