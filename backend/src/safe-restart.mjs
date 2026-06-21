/**
 * safe-restart.mjs — compatibility facade for the safe two-phase restart protocol.
 */

export {
  PENDING_RESTARTS_DIR,
  SERVICE_NAME,
  VALID_STATUSES,
  getPendingRestartsDir,
  getRestartMarkerPath,
  writePendingRestartMarker,
  loadRestartMarker,
  updateRestartMarkerStatus,
  scanPendingRestartMarkers,
  scanPendingRestartMarkersSync,
  removeRestartMarker,
} from "./safe-restart-marker-store.mjs";

export {
  scheduleDetachedRestart,
  scheduleServiceRestart,
} from "./safe-restart-scheduler.mjs";

export {
  verifyRestartMarker,
} from "./safe-restart-verifier.mjs";

export {
  validateWorkspaceRoot,
  MISPLACED_MARKER_DIAGNOSTIC,
  scanMisplacedMarkersSync,
  migrateMisplacedMarker,
  getMisplacedMarkerDiagnostic,
  removeMisplacedMarker,
} from "./safe-restart-misplaced-markers.mjs";
