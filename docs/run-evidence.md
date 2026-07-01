# Run Evidence

Run evidence is the compact, durable evidence chain for a GPTWork task run. It connects task logs, verification artifacts, acceptance evidence, queue/review packets, and compact task cards without requiring operators to read full transcripts or raw context bundles first.

## Files

Completed code-change runs write these files in the goal directory when verification evidence is collected:

- `events.jsonl` - run-local event log. Each line is a JSON event with `type`, `stage`, `message`, `artifact`, `data`, and `created_at`.
- `verification.log` - compact verification and git evidence.
- `acceptance.evidence.json` - structured result, changed files, verification log reference, and acceptance findings.
- `implementation-diff.patch` - written when a diff is available.

The task result stores these paths under `result.evidence_paths`, including `events_jsonl`.

## Event Stages

`events.jsonl` records one compact event for each operator-facing surface:

- `run_evidence.workflow` - git status, changed files, and diff summary were captured.
- `run_evidence.context` - evidence was linked to the goal output directory and result artifacts.
- `run_evidence.verification_log` - verification evidence was written.
- `run_evidence.acceptance_evidence` - acceptance evidence was written.
- `run_evidence.queue` - queue/review status can point to the run evidence artifacts.
- `run_evidence.card` - compact cards can show the evidence entrypoints.

Each event has an `artifact` object when it can point directly at a readable artifact.

## Compact Surfaces

`get_task_acceptance_bundle` exposes a `run_evidence` summary with `events_jsonl`, `artifact_keys`, supported `displays`, and `raw_evidence_readable`.

Task cards show a compact `Run evidence` section by default when evidence paths exist. The card intentionally shows paths rather than raw file contents, so the default view stays compact while raw evidence remains readable through file tools.
