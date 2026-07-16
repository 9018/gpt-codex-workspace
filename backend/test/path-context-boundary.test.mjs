import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePathContext } from "../src/path-context/path-context-validator.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeRepo(prefix) {
  const root = track(await mkdtemp(join(tmpdir(), prefix)));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "boundary@example.test"]);
  git(root, ["config", "user.name", "Boundary Test"]);
  git(root, ["commit", "--allow-empty", "-m", "initial"]);
  return root;
}

function validContext(projectRoot, overrides = {}) {
  return {
    mcpRoot: dirname(projectRoot),
    projectsRoot: dirname(projectRoot),
    workspaceRoot: dirname(projectRoot),
    projectRoot,
    canonicalRepoPath: projectRoot,
    executionCwd: projectRoot,
    worktreePath: null,
    codexHome: join(projectRoot, ".codex-runtime"),
    nativeSessionsRoot: join(projectRoot, ".codex-runtime", "sessions"),
    controlSessionsRoot: join(projectRoot, ".gptwork", "codex-sessions"),
    codexHomeMode: "project",
    ...overrides,
  };
}

test("validatePathContext rejects non-git canonical repositories", async () => {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-not-git-")));
  assert.throws(
    () => validatePathContext(validContext(root)),
    (error) => error?.code === "canonical_repo_not_git",
  );
});

test("validatePathContext rejects unrelated worktrees and project-mode CODEX_HOME escape", async () => {
  const projectRoot = await makeRepo("gptwork-boundary-project-");
  const unrelatedRoot = await makeRepo("gptwork-boundary-other-");

  assert.throws(
    () => validatePathContext(validContext(projectRoot, { worktreePath: unrelatedRoot, executionCwd: unrelatedRoot })),
    (error) => error?.code === "worktree_repo_mismatch",
  );
  assert.throws(
    () => validatePathContext(validContext(projectRoot, {
      codexHome: join(dirname(projectRoot), "escaped-codex-home"),
      nativeSessionsRoot: join(dirname(projectRoot), "escaped-codex-home", "sessions"),
    })),
    (error) => error?.code === "project_codex_home_escape",
  );
});

test("validatePathContext requires the native session root to be CODEX_HOME/sessions", async () => {
  const projectRoot = await makeRepo("gptwork-boundary-session-");
  assert.throws(
    () => validatePathContext(validContext(projectRoot, { nativeSessionsRoot: join(projectRoot, "sessions") })),
    (error) => error?.code === "native_sessions_root_invalid",
  );
});

test("production source contains no author-specific home path", async () => {
  const srcRoot = join(backendRoot, "src");
  const files = execFileSync("find", [srcRoot, "-type", "f", "-name", "*.mjs"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const offenders = [];
  for (const file of files) {
    if ((await readFile(file, "utf8")).includes("/home/a9017")) offenders.push(file.slice(srcRoot.length + 1));
  }
  assert.deepEqual(offenders, []);
});
