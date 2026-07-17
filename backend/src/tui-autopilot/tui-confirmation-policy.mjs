function pathOutsideRoots(text, roots) {
  const paths = String(text || "").match(/(?:^|\s)(\/[A-Za-z0-9._/-]+)/g) || [];
  return paths.map((value) => value.trim()).some((path) => !roots.some((root) => path === root || path.startsWith(`${root}/`)));
}

export function decideTuiConfirmation(frame = {}, { allowedRoots = [] } = {}) {
  const text = String(frame.normalized_text || "");
  const roots = allowedRoots.map((root) => String(root || "").replace(/\/$/, "")).filter(Boolean);
  const safeKind = /\b(?:npm|pnpm|yarn|node).{0,80}\btest\b/i.test(text)
    ? "run_test_within_worktree"
    : /\bgit\s+(?:status|diff|log|commit)\b/i.test(text)
      ? "git_operation_within_worktree"
      : /\b(?:read|write|edit|create|mkdir)\b/i.test(text)
        ? "worktree_io"
        : null;
  if (safeKind && !pathOutsideRoots(text, roots)) {
    return { approved: true, input: "y\r", reason_code: safeKind, alternative_instruction: null };
  }
  return {
    approved: false,
    input: "n\r",
    reason_code: pathOutsideRoots(text, roots) ? "action_outside_allowed_roots" : "unrecognized_confirmation",
    alternative_instruction: "Reject the out-of-bounds action. Continue with a safe alternative inside the current worktree and complete the task without waiting for human input.\r",
  };
}
