export class TaskProcessingError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "TaskProcessingError";
    this.code = code;
  }
}
