/**
 * safe-restart-scheduler.mjs — compatibility facade for safe restart scheduling.
 */

export { scheduleDetachedRestart } from "./safe-restart-detached-scheduler.mjs";
export { scheduleServiceRestart } from "./safe-restart-service-scheduler.mjs";
