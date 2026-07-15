import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const script of ["release-gate.mjs", "p5-release-gate.mjs"]) {
  test(`${script}: any reported blocker forces NO-GO`, async () => {
    const source = await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
    assert.match(
      source,
      /const goNoGo = blockers\.length === 0 \? ['"]GO['"] : ['"]NO-GO['"]/,
      "gate result must be derived from all reported blockers, including diagnostics",
    );
  });
}
