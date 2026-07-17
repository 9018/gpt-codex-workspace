export function buildExecutionCheckpoint({
  attempt = {},
  repository = {},
  acceptance = {},
  failure = null,
  nativeSessionId = null,
  controlSessionId = null,
  now = new Date().toISOString(),
} = {}) {
  return {
    schema_version: 1,
    task_id: attempt.task_id || null,
    execution_cwd: attempt.path_context?.execution_cwd || null,
    input_digest: attempt.input_snapshot?.digest || null,
    repo_head: repository.head || null,
    dirty_paths: Array.isArray(repository.dirty_paths) ? [...repository.dirty_paths] : [],
    completed_acceptance_items: Array.isArray(acceptance.completed_items) ? [...acceptance.completed_items] : [],
    last_error: failure ? structuredClone(failure) : null,
    native_session_id: nativeSessionId || null,
    control_session_id: controlSessionId || null,
    created_at: now,
  };
}
