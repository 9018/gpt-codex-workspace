export function createTuiScreenFrame(input = {}) {
  return {
    sequence: Number(input.sequence || 0),
    captured_at: input.captured_at || new Date().toISOString(),
    raw_tail: String(input.raw_tail || ""),
    normalized_text: String(input.normalized_text || ""),
    stable_lines: Array.isArray(input.stable_lines) ? input.stable_lines : [],
    prompt_markers: Array.isArray(input.prompt_markers) ? input.prompt_markers : [],
    selectable_options: Array.isArray(input.selectable_options) ? input.selectable_options : [],
    confirmation_markers: Array.isArray(input.confirmation_markers) ? input.confirmation_markers : [],
    error_markers: Array.isArray(input.error_markers) ? input.error_markers : [],
    progress_markers: Array.isArray(input.progress_markers) ? input.progress_markers : [],
    terminal_markers: Array.isArray(input.terminal_markers) ? input.terminal_markers : [],
    content_digest: String(input.content_digest || ""),
  };
}
