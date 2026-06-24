/**
 * repo-lock.mjs — compatibility facade for per-repository execution locks.
 */

export {
  safeRepoId,
  getLocksDir,
  getLockFilePath,
} from "./repo-lock-paths.mjs";

export {
  acquireRepoLock,
  releaseRepoLock,
  forceReleaseRepoLock,
  releaseLockForTask,
  updateRepoLock,
} from "./repo-lock-lifecycle.mjs";

export {
  reconcileRepoLocks,
} from "./repo-lock-reconciler.mjs";

export {
  getRepoLockSummary,
  listRepoLocks,
} from "./repo-lock-diagnostics.mjs";
