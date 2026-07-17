export const TASK_PROCESSING_STAGES = Object.freeze([
  "prepare",
  "dispatch",
  "normalize",
  "verify",
  "recover",
  "finalize",
]);

export function isProcessorOutput(value) {
  return Boolean(value && typeof value === "object" && (value.task_id || value.kind || value.status));
}
