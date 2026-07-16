import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { CODEX_HOME_MODES, PathContextError } from "./path-context-schema.mjs";

export function normalizeCodexHomeMode(value = "project") {
  const mode = String(value || "project").trim().toLowerCase();
  if (!CODEX_HOME_MODES.includes(mode)) {
    throw new PathContextError(
      "codex_home_mode_invalid",
      `GPTWORK_CODEX_HOME_MODE must be one of ${CODEX_HOME_MODES.join(", ")}; got ${value}`,
    );
  }
  return mode;
}

export function resolveCodexHome({ projectRoot, mode = "project", explicitPath = null } = {}) {
  const normalizedMode = normalizeCodexHomeMode(mode);
  if (normalizedMode === "user") return join(homedir(), ".codex");
  if (normalizedMode === "explicit") {
    const value = String(explicitPath || "").trim();
    if (!value) {
      throw new PathContextError(
        "codex_home_explicit_path_required",
        "GPTWORK_CODEX_HOME is required when GPTWORK_CODEX_HOME_MODE=explicit",
      );
    }
    if (!isAbsolute(value)) {
      throw new PathContextError("codex_home_not_absolute", "GPTWORK_CODEX_HOME must be an absolute path");
    }
    return resolve(value);
  }
  if (!projectRoot) {
    throw new PathContextError("project_root_unresolved", "projectRoot is required for project CODEX_HOME mode");
  }
  return join(resolve(projectRoot), ".codex-runtime");
}
