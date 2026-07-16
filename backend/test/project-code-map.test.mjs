import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildProjectCodeMap } from "../src/context-index/project-code-map.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("buildProjectCodeMap indexes tracked source files and persists a stable cache", () => {
  const root = mkdtempSync(join(tmpdir(), "gptwork-code-map-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "GPTWork Test"]);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "src", "math.mjs"), [
      'import { strict as assert } from "node:assert";',
      "export function add(a, b) {",
      "  assert.equal(typeof a, 'number');",
      "  return a + b;",
      "}",
    ].join("\n"));
    writeFileSync(join(root, "test", "math.test.mjs"), [
      'import { add } from "../src/math.mjs";',
      "add(1, 2);",
    ].join("\n"));
    writeFileSync(join(root, "ignored.mjs"), "export const ignored = true;\n");
    git(root, ["add", "src/math.mjs", "test/math.test.mjs"]);
    git(root, ["commit", "-qm", "fixture"]);

    const first = buildProjectCodeMap({ repoRoot: root });
    assert.equal(first.cache_hit, false);
    assert.equal(first.git_head, git(root, ["rev-parse", "HEAD"]));
    assert.deepEqual(Object.keys(first.files).sort(), ["src/math.mjs", "test/math.test.mjs"]);
    assert.equal(first.files["src/math.mjs"].line_count, 5);
    assert.deepEqual(first.files["src/math.mjs"].exports, ["add"]);
    assert.deepEqual(first.files["src/math.mjs"].imports, ["node:assert"]);
    assert.deepEqual(first.files["src/math.mjs"].test_files, ["test/math.test.mjs"]);
    assert.match(first.files["src/math.mjs"].content_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.directories, ["src", "test"]);

    const persistedPath = join(root, ".gptwork", "context-index", "code-map.json");
    const persisted = JSON.parse(readFileSync(persistedPath, "utf8"));
    assert.equal(persisted.revision, first.revision);
    assert.equal(persisted.cache_hit, undefined);

    const second = buildProjectCodeMap({ repoRoot: root });
    assert.equal(second.cache_hit, true);
    assert.equal(second.revision, first.revision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildProjectCodeMap invalidates only changed file entries when content changes", () => {
  const root = mkdtempSync(join(tmpdir(), "gptwork-code-map-change-"));
  try {
    git(root, ["init", "-q"]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b.mjs"), "export const b = 2;\n");
    git(root, ["add", "."]);
    const first = buildProjectCodeMap({ repoRoot: root });

    writeFileSync(join(root, "src", "a.mjs"), "export const a = 3;\n");
    const second = buildProjectCodeMap({ repoRoot: root });

    assert.equal(second.cache_hit, false);
    assert.deepEqual(second.refreshed_files, ["src/a.mjs"]);
    assert.notEqual(second.files["src/a.mjs"].content_digest, first.files["src/a.mjs"].content_digest);
    assert.equal(second.files["src/b.mjs"].content_digest, first.files["src/b.mjs"].content_digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
