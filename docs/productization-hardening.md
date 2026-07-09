# Productization Hardening

## 2026-07-10 P0 hard blockers

Actual code state reviewed in this task:

- `backend/src/agent-execution-backends.mjs` imported under Node ESM, but contained stale generated residue after `resolveBackendSource`: an extra `/**` plus `});` inside the next JSDoc, and a duplicate semicolon after `ROLE_BACKEND_DEFAULTS`. The residue was removed so the module is cleanly parseable and importable.
- `backend/src/task-final-writeback.mjs` called `shouldAttemptRepairFn` and `createRepairGoalFromFindingsFn` synchronously in integration-repair and closure-repair paths. Those dependency hooks are awaited in `task-general-processor.mjs` and tests commonly provide async implementations, so final writeback now awaits both hooks in both paths.
- `backend/src/task-general-processor.mjs` used `uniqueStrings` in the `already_integrated` delivery recovery path without defining it. A local helper now deduplicates non-empty string warnings before writeback.

Verification run:

- `node -e 'import("./backend/src/agent-execution-backends.mjs").then(() => console.log("agent-execution-backends import ok"))'` - passed.
- `npm --prefix backend run check:syntax` - passed, 506 files checked.
- `npm --prefix backend run check:imports` - passed, `imports ok`.
- `node --test --test-reporter=dot backend/test/agent-execution-backends.test.mjs backend/test/pipeline-orchestration.test.mjs` - passed.
- `node --test --test-reporter=dot backend/test/task-general-processor.test.mjs` - passed.
- `node --test --test-reporter=dot --test-name-pattern='repairable acceptance blockers create traceable follow-up task|integration repair awaits async repair helpers' backend/test/task-final-writeback.test.mjs` - passed.

Known remaining risk:

- Full `backend/test/task-final-writeback.test.mjs` still has four existing failures unrelated to this task's P0 fixes: dependent queue unblock assertions, dirty auto integration queue blocking, queue item sync for `waiting_for_repair`, and goal status wording for missing evidence. These failures were present before the await fixes were applied and should be handled as a separate closure/queue consistency task.
