import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dirname = typeof __dirname !== "undefined"
  ? __dirname
  : join(fileURLToPath(import.meta.url), "..");
const serverPath = join(dirname, "../src/gptwork-server.mjs");

test("gptwork-server.mjs has no inline MCP tool registrations", () => {
  const source = readFileSync(serverPath, "utf8");
  const lines = source.split("\n");

  const inlineToolLines = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => /:\s*tool\(/.test(line));

  assert.equal(
    inlineToolLines.length,
    0,
    `Expected no inline ': tool(' registrations in gptwork-server.mjs, found ${inlineToolLines.length}:\n${
      inlineToolLines.map(({ idx, line }) => `  line ${idx + 1}: ${line.trim()}`).join("\n")
    }`
  );
});
