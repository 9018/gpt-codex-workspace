import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

async function exists(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function codexTuiGoalArtifactCandidates({ workspaceRoot, cwd, goalId, filename }) {
  if (!goalId || !filename) return [];
  const candidates = [];
  if (workspaceRoot) {
    candidates.push(join(workspaceRoot, ".gptwork", "runtime-goals", goalId, filename));
    candidates.push(join(workspaceRoot, ".gptwork", "goals", goalId, filename));
  }
  if (cwd) {
    candidates.push(join(cwd, ".gptwork", "runtime-goals", goalId, filename));
    candidates.push(join(cwd, ".gptwork", "goals", goalId, filename));
  }
  return [...new Set(candidates)];
}

export async function firstExistingArtifactPath(candidates = []) {
  for (const path of candidates) {
    if (await exists(path)) return path;
  }
  return null;
}

export async function firstMatchingJsonArtifact(candidates = [], predicate = () => true) {
  for (const path of candidates) {
    if (!await exists(path)) continue;
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) return { path, value };
    } catch {
      // Continue to lower-priority candidates. The caller will report invalid
      // evidence when no usable candidate is found.
    }
  }
  return null;
}
