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
    controlSessionsRoot: join(projectRoot, ".gptwork", "codex-sessions"),
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

test("validatePathContext rejects projectsRoot being used as projectRoot", async () => {
  const projectRoot = await makeRepo("gptwork-boundary-projects-root-");
  assert.throws(
    () => validatePathContext(validContext(projectRoot, { projectsRoot: projectRoot })),
    (error) => error?.code === "projects_root_is_project_root",
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
