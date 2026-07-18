import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePathContext } from "../src/path-context/path-context-resolver.mjs";
import { track, afterEachHook } from "./helpers/temp-cleanup.mjs";

afterEachHook(test);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeRepo() {
  const root = track(await mkdtemp(join(tmpdir(), "gptwork-path-context-")));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "path-context@example.test"]);
  git(root, ["config", "user.name", "Path Context Test"]);
  await mkdir(join(root, "src"));
  git(root, ["add", "."]);
  git(root, ["commit", "--allow-empty", "-m", "initial"]);
  return root;
}

test("resolvePathContext prefers task bindings and validates a linked worktree", async () => {
  const projectRoot = await makeRepo();
  const worktreePath = `${projectRoot}-worktree`;
  track(worktreePath);
  git(projectRoot, ["worktree", "add", "-b", "task/path-context", worktreePath, "HEAD"]);

  const context = await resolvePathContext({
    mcpRoot: join(projectRoot, ".."),
    projectsRoot: join(projectRoot, ".."),
    workspaceRoot: join(projectRoot, ".."),
    task: {
      id: "task_path",
      worktree_path: worktreePath,
      result: { repo_resolution: { canonical_repo_path: projectRoot } },
    },
    repository: { canonical_path: "/must/not/win" },
    config: { defaultRepoPath: "/also/must/not/win" },
  });

  assert.equal(context.projectRoot, projectRoot);
  assert.equal(context.canonicalRepoPath, projectRoot);
  assert.equal(context.worktreePath, worktreePath);
  assert.equal(context.executionCwd, worktreePath);
  assert.equal(context.controlSessionsRoot, join(projectRoot, ".gptwork", "codex-sessions"));
});

test("resolvePathContext uses repository then explicit config then default repository", async () => {
  const repositoryRoot = await makeRepo();
  const explicitRoot = await makeRepo();
  const defaultRoot = await makeRepo();

  const repositoryContext = await resolvePathContext({
    repository: { canonical_path: repositoryRoot },
    config: { projectRoot: explicitRoot, defaultRepoPath: defaultRoot },
  });
  assert.equal(repositoryContext.projectRoot, repositoryRoot);

  const explicitContext = await resolvePathContext({
    config: { projectRoot: explicitRoot, defaultRepoPath: defaultRoot },
  });
  assert.equal(explicitContext.projectRoot, explicitRoot);

  const defaultContext = await resolvePathContext({
    config: { defaultRepoPath: defaultRoot },
  });
  assert.equal(defaultContext.projectRoot, defaultRoot);
});

test("resolvePathContext treats projectRoot-shaped projectsRoot as a container", async () => {
  const projectRoot = await makeRepo();

  const context = await resolvePathContext({
    projectsRoot: projectRoot,
    repository: { canonical_path: projectRoot },
    config: {},
  });

  assert.equal(context.projectRoot, projectRoot);
  assert.equal(context.projectsRoot, join(projectRoot, ".."));
});

test("resolvePathContext fails closed instead of falling back to cwd or workspaceRoot", async () => {
  await assert.rejects(
    () => resolvePathContext({ workspaceRoot: process.cwd(), config: {} }),
    (error) => error?.code === "project_root_unresolved",
  );
});
