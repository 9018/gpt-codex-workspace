# Release Gate

> Pre-release verification checklist for the delivery system.

## Gate Requirements

1. All unit tests pass (1448+ tests)
2. Syntax check passes for all source files
3. Import check passes for all modules
4. E2E delivery smoke test passes
5. No blocker or major acceptance findings

## Gate Script

```bash
npm run release:delivery-check
```

## Release Matrix

| Test Area | File | Status |
|---|---|---|
| Delivery contracts | `test/delivery-contracts.test.mjs` | ✅ |
| Worktree lifecycle | `test/task-worktree-manager.test.mjs` | ✅ |
| Queue scheduling | `test/goal-queue.test.mjs` | ✅ |
| Context retrieval | `test/context-index.test.mjs` | ✅ |
| Acceptance policy | `test/acceptance-policy.test.mjs` | ✅ |
| Repo locks | `test/repo-lock.test.mjs` | ✅ |
| E2E delivery | `test/e2e-delivery.test.mjs` | ✅ |

## Failure Handling

If any gate check fails:
1. Identify the failing module from the output
2. Check the module's test file for the specific assertion
3. Fix the issue and re-run the gate
4. Do not release until the gate passes
