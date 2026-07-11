# Review Backlog Convergence Report — 2026-07-11

Scanned at: 2026-07-11T18:34:10.888Z

## Summary

| Metric | Count |
|---|---|
| Total tasks in state | 395 |
| Scanned (review-relevant) | 392 |
| Reconciled | 236 |
| Still blocked | 139 |
| Human review required | 0 |

## Typed Recovery Counts

- missing_contract_verification: 83
- reconciled_by_completion: 148
- reconciled_by_integration: 13
- reconciled_by_successor: 5
- reconciled_diagnostic_no_mutation: 6
- reconciled_status: 151

## Status Distribution

- answered: 1
- cancelled: 4
- completed: 274
- failed: 84
- queued: 1
- running: 1
- timed_out: 1
- waiting_for_review: 29

## Still-Blocked Tasks

### task_9e0275bd-036a-445b-8547-b7d37817d0a1 (bundle: failed)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository could not fast-forward to recovered commit.
### task_cf8c20b2-e512-48d2-b395-16b42e3281c3 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_438c4738-84ae-4192-9339-b5260bf947e4 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_8e6ad43d-1cb4-41f9-b3d3-138bf67d45ef (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
### task_563ee856-b699-4fb1-aa59-4d22d90bae84 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_b6cf8ba9-777b-4587-aa99-8210787cb656 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/task-final-writeback.mjs, backend/test/task-final-writeback.test.mjs
### task_7b0723e9-e367-4e32-a037-1ce5edfe48e5 (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_e2c39c72-07c8-40e7-9429-f94aa9dd07bc (bundle: waiting_for_review)
- **auto_integration_completion_failed** (blocker): No changed_files evidence is present.
### task_602ee51e-9755-4132-8c34-3d28bd0c3353 (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_5003bb22-a4d6-4421-9fe9-efe083c7133f (bundle: waiting_for_review)
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
### task_0b2b3ec8-7008-495d-8b18-6efac65a76ae (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository could not fast-forward to recovered commit.
### task_138e6894-126f-4b47-bc5c-58dd812dba24 (bundle: waiting_for_review)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_f8fefae8-2204-4a83-9c30-496c7a080c13 (bundle: completed)
- **auto_integration_completion_failed** (blocker): No changed_files evidence is present.
### task_540a57bd-1bf1-4d57-9d00-c12cda7d97a6 (bundle: waiting_for_review)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
### task_27d12b59-2ebd-4c06-b121-574a9453a6f5 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
### task_752dd0b2-e859-4c4f-9de4-6d97e67a87ea (bundle: failed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/agent-run-writeback.mjs, backend/src/task-general-processor.mjs, backend/src/task-final-writeback.mjs, backend/src/repair-loop.mjs, backend/src/agent
### task_359ced50-7b38-43db-85af-f39ccb200d25 (bundle: completed)
- **changed_files_extra_in_git** (major): Files in git diff not listed in result: backend/src/agent-run-service.mjs, backend/src/agent-run-writeback.mjs, backend/src/repair-loop.mjs, backend/src/task-final-writeback.mjs, backend/test/agent-ru
### task_f4d55183-bdf5-4864-91a5-69609c309dae (bundle: failed)
- **codex_failed** (blocker): Diagnostic repair of MA3 AgentRun Writeback integration: fixed import embedded in JSDoc comment + SyntaxError in non-async callback + misplaced writeRepairerAgentRun calls
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_3fb62b1b-2d1e-477d-ba62-2947fee92a52 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_6fd9c594-43a3-4582-a135-d2f1484502d2 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_037f4a32-129a-40b4-ac5f-b83a5b255ef0 (bundle: waiting_for_review)
- **auto_integration_completion_failed** (blocker): No changed_files evidence is present.
### task_3296b423-8330-4e9d-9f81-5139f4496e24 (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_278326dd-2115-4241-85f2-3b8a803c6481 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_d0bd3364-ac70-4a06-bdf7-9a8b64a3171b (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_bdda7a73-f750-401b-8cf9-12f12458827d (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_3cd43a09-0d3b-4641-b364-0ea7bed3158b (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_3c945395-bc7d-4f91-aa9a-fdaec0f54f89 (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository could not fast-forward to recovered commit.
### task_b1f5e442-90c2-4b1c-bc4f-50143877c51f (bundle: failed)
- **codex_failed** (blocker): P0-MA11: Force AgentRun into main lifecycle, enforce pipeline gate, normalize verification blockers, add backlog convergence
- **delivery_result_recovery_failed** (blocker): No staged changes were available for recovery commit.
### task_404a41b3-c22b-48a5-952a-60d2d78b5ad7 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository is dirty before recovery.
### task_15b2f7e9-a921-4b52-9dca-f3357aabcdd1 (bundle: waiting_for_review)
- **dry_run_evidence_missing** (blocker): Blocking contract requires dry-run evidence.
- **apply_evidence_missing** (blocker): Blocking contract requires apply evidence.
- **before_after_counts_missing** (blocker): Blocking contract requires before/after count evidence.
- **active_items_preserved_missing** (blocker): Blocking contract requires active item preservation evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **dry_run_evidence_missing** (blocker): Blocking contract requires dry-run evidence.
- **apply_evidence_missing** (blocker): Blocking contract requires apply evidence.
- **before_after_counts_missing** (blocker): Blocking contract requires before/after count evidence.
- **active_items_preserved_missing** (blocker): Blocking contract requires active item preservation evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_52036c5d-31e7-4d04-92a9-c429989742c2 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_1afdc197-758e-4ec5-b456-fe92acdf3321 (bundle: waiting_for_review)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_c54c1587-1a9a-4a86-8e7a-1d429a975f23 (bundle: completed)
- **pipeline_gate_blocking** (blocker): Pipeline gate blocking: finalizer - result
### task_8737bae6-d8b2-46f2-87e7-23173e0c6c33 (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_8b1a997e-5363-4e06-a0d2-88475a868a31 (bundle: completed)
- **pipeline_gate_blocking** (blocker): Pipeline gate blocking: finalizer - result
### task_cbcd2cbd-7cd9-441a-aebe-0a39175cf1f5 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_e4776145-e7d5-451a-adeb-114b4a9ecaeb (bundle: waiting_for_review)
- **pipeline_gate_blocking** (blocker): Pipeline gate blocking: finalizer - result
### task_a98025a2-a980-4639-ab66-0c1368132e5f (bundle: completed)
- **pipeline_gate_blocking** (blocker): Pipeline gate blocking: finalizer - result
### task_c52e7d35-a56b-4f70-9655-e5c9e221a8ee (bundle: waiting_for_review)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_dea3cd72-2c95-4b15-aac8-2630d85cb60f (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_de17831e-6d6a-426c-a1db-7365dc3a7177 (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_1010240e-3b4c-4b41-a03a-04b19ea7651a (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_221e736a-7379-467a-a2b1-f6569275709e (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/backlog-census.mjs, backend/test/backlog-census.test.mjs, backend/package.json
### task_52fe25df-897a-4195-9600-ee2ff727a2b5 (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/scripts/run-census-migration-report.mjs"]}
### task_83cfb44b-bbe4-4f2c-9d5e-5f1dbf22ae79 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_4b92ea3c-12dd-40e6-bde7-293330c77d03 (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_e1cfa8c2-96db-47bc-bf87-83fd76d0ac02 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_00e62534-3499-447b-bb24-609056c6fa17 (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_8adeae68-c6a4-4726-9f56-bcd48e75571e (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_5fa2d809-009c-46a6-ac1f-f76afff195b2 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/auto-integration-completion.mjs","backend/src/current-blocker-poli
### task_f68d7bab-5cfa-45e5-bcbc-3732f72c0b4c (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_51bdaf36-8813-4218-a1ef-d79536595b0b (bundle: waiting_for_review)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_862d5db7-cb94-4ded-8282-c9ef52af3659 (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_4936a614-bebe-4fe8-be79-5479992b2445 (bundle: completed)
- **auto_integration_completion_failed** (blocker): No changed_files evidence is present.
### task_320fcf0e-5865-4225-873c-1bdfe464fc0d (bundle: waiting_for_review)
- **dirty_worktree_after_codex** (major): Contract violation: dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Delivery recovery verification command failed.
### task_887f3995-ba05-473e-95ed-88d9a8c88b2e (bundle: completed)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/agent-execution-backends.mjs","backend/src/card-runtime-cards.mjs"
### task_802502a0-38c9-4ea8-97d2-c1e5cd3bcfb2 (bundle: completed)
- **auto_integration_completion_failed** (blocker): Command failed: git commit -m Auto integrate task_802502a0-38c9-4ea8-97d2-c1e5cd3bcfb2: Repair: P0-06 Init Onboarding Productization (attempt 1) -m Original task commit: 600703c30284c72fa4882c77b6ab2b
### task_9976a0ff-0a7a-4e15-861c-5c6fc6852719 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **verification_not_passed** (blocker): Verification did not pass.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **verification_not_passed** (blocker): Verification did not pass.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_596ff38d-f9b6-4500-a8f0-e1d6afed7b42 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: docs/current-status.md, docs/architecture.md, backend/test/pipeline-orchestration.test.mjs
### task_e419addb-9eea-4269-832b-fb01315dc87a (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/context-contract-diagnostics.mjs, backend/src/codex-prompt-builder.mjs, backend/src/diagnostics-context-status.mjs, backend/test/context-contract-dia
### task_00b0f00b-68c1-45c4-8fc5-167027bac248 (bundle: completed)
- **non_docs_changed** (blocker): Non-documentation files changed in docs-only profile: .gptwork/runtime.env.example, backend/src/onboarding-init.mjs, backend/src/runtime-config.mjs, backend/test/onboarding-init.test.mjs
### task_b29e6ca3-e070-4d52-aa65-73e962cf84a3 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_5388ff4c-50d7-4659-85a4-e559ff7b9029 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_fa6a346a-846f-46f2-9bbd-c556c599ff49 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_fb491b00-d5b9-4236-9cba-b71c91671fcf (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_36487431-5ed9-4383-9ca9-d2f06881ff4a (bundle: completed)
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_771905f8-b0f9-48c2-971b-4ca891186b98 (bundle: completed)
- **non_docs_changed** (blocker): Non-documentation files changed in docs-only profile: backend/src/delivery-result-recovery.mjs, backend/src/evidence/evidence-normalizer.mjs, backend/src/task-final-writeback.mjs, backend/test/accepta
### task_eaad882f-271e-47d8-9125-19e2f4947dcc (bundle: completed)
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_008758ce-48ec-439d-a9ce-f63f7019c210 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_c7f8d7c6-7258-4ff7-8bec-f06c2082f21b (bundle: completed)
- **non_docs_changed** (blocker): Non-documentation files changed in docs-only profile: backend/src/task-final-writeback.mjs, backend/test/acceptance-contract-verifier.test.mjs, backend/test/operation-evidence.test.mjs, backend/test/t
### task_571e817b-710d-44ef-bcb5-70f5b748dc59 (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_05e20108-00d8-40dd-bc5e-c60a52f9f706 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_4d96aac5-c70f-44ea-8d9c-6327730def77 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_2696f73a-cdc0-42ec-9e7b-6fa0e94a9ef0 (bundle: completed)
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_466add97-f75c-44f5-b2e6-5ff1dc4d7504 (bundle: completed)
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_ffd53345-683d-41b0-8643-8538c28929cb (bundle: completed)
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
- **audit_evidence_missing** (blocker): Blocking contract requires audit evidence.
### task_9546a96b-3e3b-47f9-b289-1256bcb0fe03 (bundle: completed)
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_12515c27-721b-4903-afe1-a325385c75c0 (bundle: completed)
- **dirty_worktree_after_codex** (major): Contract violation: dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Both sides diverged: canonical 1 ahead, worktree 1 ahead of merge-base. Simple rebase may not suffice.
### task_1e5cf5c3-60af-488c-baac-b1501edfaa5d (bundle: completed)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["README.zh-CN.md"],"unexpected_source_mutation":["docs/architecture.md","docs/codex-exec-productio
### task_9e4fe040-3652-4a0b-b6b7-6ab4b59f9e9b (bundle: completed)
- **dirty_worktree_after_codex** (major): Contract violation: dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["README.zh-CN.md"],"unexpected_source_mutation":["backend/bin/gptwork.mjs","backend/src/product-st
### task_65b65512-05d6-481b-b41e-e3a94fcb69f1 (bundle: completed)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["README.zh-CN.md"],"unexpected_source_mutation":["backend/bin/gptwork.mjs","backend/src/product-st
### task_08585c45-8435-48fe-ad87-066d7e5e5943 (bundle: completed)
- **non_docs_changed** (blocker): Non-documentation files changed in docs-only profile: backend/src/card-view-model.mjs, backend/test/card-view-model.test.mjs
### task_e38875ed-e2ef-4c82-b66d-f7a8e27aba2d (bundle: completed)
- **semantic_ambiguity** (blocker): Acceptance contract has low semantic confidence and requires review.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **semantic_ambiguity** (blocker): Acceptance contract has low semantic confidence and requires review.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_35c16403-9602-4d71-88c4-571ef289fcbc (bundle: completed)
- **non_docs_changed** (blocker): Non-documentation files changed in docs-only profile: backend/src/runtime-reconciler.mjs, backend/src/runtime-watch-diagnostics.mjs, backend/test/runtime-watch-diagnostics.test.mjs
### task_ed0a25dd-4905-45b4-8643-b91a67dff3c2 (bundle: failed)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/acceptance-gate-engine.test.mjs"]}
### task_64b5df16-d687-4509-b283-ae95fff567b0 (bundle: completed)
- **auto_integration_completion_failed** (blocker): Task commit none does not exist.
### task_e5b1ca50-1208-4d85-b0d0-856a14182e4c (bundle: failed)
- **auto_integration_completion_failed** (blocker): Post-merge verification failed: report_failed.
### task_7e008c58-f87e-4d6a-ab4d-8e6bb8624a47 (bundle: completed)
- **changed_files_extra_in_git** (major): Files in git diff not listed in result: backend/src/auto-integration-completion.mjs, backend/src/closure/task-closure-reconciler.mjs, backend/src/delivery-result-recovery.mjs, backend/src/evidence/evi
### task_7836fe1b-218a-486f-96c0-4f0262f35000 (bundle: completed)
- **changed_files_reported_missing** (blocker): Blocking contract requires changed_files evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_not_passed** (blocker): Verification did not pass.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
- **worktree_clean_unknown** (major): Unable to verify worktree cleanliness
- **verification_command_failed** (blocker): One or more verification commands failed
- **existing_blocking_findings** (blocker): Task has 1 existing blocker/major finding(s)
- **changed_files_reported_missing** (blocker): Blocking contract requires changed_files evidence.
- **integration_completed_missing** (blocker): Blocking contract requires completed integration evidence.
- **verification_not_passed** (blocker): Verification did not pass.
- **integration_completed_missing** (blocker): Contract requires integration evidence.
### task_4a242301-c114-4101-99ed-c71bc3a7bbc9 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_91a95c0f-ec5a-4f7f-81ba-e1392e685bc4 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_b5f03879-7708-461f-92f5-e9a86e7b674e (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_ea65fd5f-9955-4cec-9fd8-3d9af8450587 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_ab256e79-cb7f-48d8-9020-8a39a43ccbec (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_c1027163-3af3-4634-82a7-6e727cee86bc (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_3e161217-e313-426e-8643-44b65790ee20 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_791d4fa8-8b61-4ccf-a3ca-c4fc7d7c421c (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_9f224469-1fab-4ff0-beff-0edb35994028 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_db3c971a-f59f-4841-87e9-481e02cd7e2f (bundle: cancelled)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_67f4557e-4421-409b-88bb-f0015da6e247 (bundle: cancelled)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_51dfceb5-8709-41e8-94f7-cc6e413e8c60 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/tool-groups/workflow-tools-group.mjs","backend/src/tool-result-sum
### task_55522267-70c2-4540-bf2d-fdb239ee4b82 (bundle: completed)
- **dirty_worktree_after_codex** (major): Contract violation: commit_missing, dirty_worktree_after_codex
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_7080d879-a5c1-4154-84b6-d8e0a2da7992 (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_6e960249-ec26-49ae-979d-459ff4beb4f0 (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_fa02f62d-07ec-4b8f-b5ac-712f38a4e28d (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_f591a9a7-947e-45ab-b973-44194ca80c85 (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_5bd0c254-d856-489d-91ee-e3a6f0088b95 (bundle: completed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_337819c7-b272-438c-9bfb-8a50cd0ca098 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_22572f2b-fca6-4c6c-856e-25ac8d398ea1 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_c64b79fd-9b97-48b6-87c0-6029cb2cad98 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_269328e6-f01e-44d6-9876-fb95bdbdd7cf (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_4b6b559a-48c1-43dc-8166-d1657765b561 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/package.json","gptwork_tui_superpowers_plan.zip","gptwork_tui_first_mvp_plan/"],"unexpect
### task_af99687d-0355-4368-a33d-975c35e2bc7c (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_d1459551-3d30-4edd-9cbf-da0ae555e86e (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_6c42a6a8-7a8a-4a7f-8084-af7bb5823acd (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/onboarding-init.mjs","backend/src/runtime-config.mjs","backend/src
### task_304860f6-fe71-4c44-b0b1-23f9636a9e47 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/apps-sdk-card/tool-result.mjs","backend/src/onboarding-init.mjs","
### task_f37eb67f-f712-4e44-9c87-094914842d0a (bundle: cancelled)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_2282f08e-3388-449b-ba6e-bc6025273b09 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_39fa0c4d-bbe3-4ec8-ae6c-7f24acf74990 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_d017de49-67b3-4554-afe8-412a4c4bf99e (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_fcc404cc-986f-4457-acc9-e448678d433a (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_8eca3a98-9e96-447d-9a76-b0c3cff6b272 (bundle: failed)
- **operation_kind_mismatch** (blocker): Result operation_kind code_change does not match contract operation_kind docs_only.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
- **operation_kind_mismatch** (blocker): Result operation_kind code_change does not match contract operation_kind docs_only.
- **verification_command_missing** (blocker): Required verification command was not evidenced: docs_check
### task_2839b7ee-ab9e-463e-ab08-ff1fc3c05d1c (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_9d28915e-41e4-4d70-8b1d-42bd371290b4 (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_bb3f315e-93a0-444e-8835-54dde6057c3f (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_af7053d2-1539-4499-928d-c1b6d462d65d (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_0fdfcc42-e7f2-47ab-8fa8-4e3619739ed1 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_9d2364d7-deb7-4bcc-a726-9c84c21aa328 (bundle: completed)
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
### task_46b97581-1ff1-41d3-b3eb-3db68e9bce34 (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","backend/src/codex-tui-pty-adapter.m
### task_2caee1c5-a100-4cd9-aced-2b0301168d59 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/README.md"],"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","bac
### task_3f216548-91f8-44c7-beed-3cd3363f59ce (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/README.md"],"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","bac
### task_475c2f23-f90d-4840-8080-06c8931a3e83 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unknown":["backend/README.md"],"unexpected_source_mutation":["backend/src/codex-tui-evidence-cycle.mjs","bac
### task_6801e3dd-94e3-49d4-83c0-366774c24efc (bundle: failed)
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
### task_9a80abbd-b0fa-487e-a73f-3fd174d605cc (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/test/lifecycle-acceptance.test.mjs, docs/closure-acceptance.md
### task_68f27155-03dd-4304-b2f0-9681f35dee5f (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: acceptance.contract.json, .gptwork/goals/goal_72910b51-5f38-4a14-a45a-511ceef17a07/result.json, .gptwork/goals/goal_72910b51-5f38-4a14-a45a-511ceef17a07/result.m
### task_ae792867-879c-402b-a53a-103f1a285c88 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Task worktree has no changed files to recover.
### task_ac84a257-c38b-4b6c-8e81-c8f4255191e9 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_92652ed4-6807-49c7-bdd2-338b8b707517 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_84993f22-f888-4ca5-812f-04b5c37d5d36 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_f431b521-628e-4993-8502-edf8c575fc11 (bundle: failed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_fcc07026-5192-4ee3-a3ca-d3dc7fd46c91 (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_adb19d63-89bf-4533-80a3-3342f3ef3f0e (bundle: completed)
- **codex_failed** (blocker): NO-OP: Codex execution completed with no changes. See diagnostics for details.
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["backend/test/codex-tui-evidence-cycle.test.mjs","backend/test/codex-tui-provid
### task_2e30db16-a77c-480b-a3e9-3422eb69e2cc (bundle: completed)
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
- **operation_kind_mismatch** (blocker): Result operation_kind file_write does not match contract operation_kind diagnostic.
- **file_evidence_missing** (blocker): Completed file_write result requires file_evidence evidence.
- **no_mutation_evidence_missing** (blocker): Blocking contract requires no-mutation evidence.
### task_b7fcb7d5-4d10-4fc2-8ba1-78d00bb5def7 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/backlog-census.mjs, backend/test/backlog-census.test.mjs, backend/package.json
### task_a2d3d1c2-ec47-4adf-98c4-b3a4eb653145 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/package.json
### task_7c0c0d3f-8d6a-424b-883d-bed2ef0cd453 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/backlog-census.mjs, backend/test/backlog-census.test.mjs, backend/test/census-migration-report.test.mjs, backend/scripts/run-census-migration-report.
### task_0c5a7b1d-8178-4e5d-800d-cb807cc5cab4 (bundle: waiting_for_review)
- **operation_kind_mismatch** (blocker): Result operation_kind code_change does not match contract operation_kind data_migration.
- **dry_run_evidence_missing** (blocker): Blocking contract requires dry-run evidence.
- **before_after_counts_missing** (blocker): Blocking contract requires before/after count evidence.
- **verification_not_passed** (blocker): Verification did not pass.
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/backlog-census.mjs, backend/test/backlog-census.test.mjs, backend/test/census-migration-report.test.mjs, backend/scripts/run-census-migration-report.
- **operation_kind_mismatch** (blocker): Result operation_kind code_change does not match contract operation_kind data_migration.
- **dry_run_evidence_missing** (blocker): Blocking contract requires dry-run evidence.
- **before_after_counts_missing** (blocker): Blocking contract requires before/after count evidence.
- **verification_not_passed** (blocker): Verification did not pass.
### task_7e73d511-edd2-456c-860c-d8f46d5b4686 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: backend/src/backlog-census.mjs, backend/test/backlog-census.test.mjs, backend/test/census-migration-report.test.mjs, backend/test/task-final-writeback.test.mjs, 
### task_c6bf2d9a-dfdd-442a-9266-2b4b9b5f38ca (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: docs/evidence-repair-verification.md, .gptwork/goals/goal_cbb62c42-d15f-4815-a8f4-6fbd95b511c2/result.json
### task_d7ba9bde-99a0-498e-aa0b-ec95fd64955b (bundle: completed)
- **stale_retained_worktree_warning** (blocker): Completed task result still advertises a retained worktree warning.
### task_d5438fe8-077c-458d-9b03-ca2bd04087e8 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: docs/evidence-repair-verification.md
### task_a3e22415-53e2-4e5a-b8b8-6ab8a0a7b9c9 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: docs/evidence-repair-verification.md
### task_d8b369fe-34a5-4ab2-89c8-f4a0e8a9e517 (bundle: timed_out)
- **codex_timed_out** (blocker): Codex execution timed out
### task_b3fd0ab7-8ac3-43e1-9514-d78192a40610 (bundle: waiting_for_review)
- **codex_timed_out** (blocker): Codex execution timed out
- **codex_timed_out** (blocker): Codex execution timed out
- **codex_failed** (blocker): Codex execution timed out
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["plugins/gpt-codex-workspace/mcp/server.mjs"]}
### task_2cb62618-e1f0-4e15-afeb-2a87ca7c8d94 (bundle: failed)
- **codex_failed** (blocker): Codex execution failed (non-zero exit)
- **delivery_result_recovery_failed** (blocker): Canonical repository has unexpected source mutations. Human interrupt required. Evidence: {"unexpected_source_mutation":["plugins/gpt-codex-workspace/mcp/server.mjs"]}
### task_2e29677c-daeb-45b6-ae12-0f32ac131130 (bundle: completed)
- **changed_files_mismatch** (major): Files in result not found in git diff: .gptwork/goals/goal_6c2ef42c-2164-4b4c-81fd-a65edc1f6854/result.md, .gptwork/goals/goal_6c2ef42c-2164-4b4c-81fd-a65edc1f6854/result.json

## Witness

- Runner: `review-backlog-convergence.mjs`
- State path: `/home/a9017/mcp/workspace/.gptwork/state.json`
- Generated by: `repair_task_4726ea9d`
