import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath } from "../src/path-utils.mjs";

test("resolveWorkspacePath keeps relative paths inside the workspace root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gptwork-root-")));
  const resolved = await resolveWorkspacePath(root, "nested/file.txt");

  assert.equal(resolved.root, root);
  assert.equal(resolved.relativePath, "nested/file.txt");
  assert.match(resolved.absolutePath, /nested[\\/]file\.txt$/);
});

test("resolveWorkspacePath rejects traversal outside the workspace root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gptwork-root-")));

  await assert.rejects(
    () => resolveWorkspacePath(root, "../outside.txt"),
    /outside workspace root/
  );
});
