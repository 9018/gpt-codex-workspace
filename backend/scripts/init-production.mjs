#!/usr/bin/env node
/**
 * init-production.mjs — One-shot production initialization script.
 *
 * Validates the production baseline, creates required directories,
 * and prints a readiness summary. Designed to be run once during
 * initial deployment after npm install.
 *
 * Usage:
 *   node scripts/init-production.mjs
 *   node scripts/init-production.mjs --check-only
 */

import { access, constants, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(SCRIPTS_DIR, "..");
const PROJECT_ROOT = resolve(BACKEND_ROOT, "..");

const REQUIRED_DIRS = [
  "data/workspaces/default",
  "data/workspaces/archive",
  "data/logs",
  ".gptwork/goals",
  ".gptwork/reports",
  ".gptwork/workflows",
];

const REQUIRED_FILES = [
  { path: "backend/package.json", label: "package.json" },
  { path: "backend/src/cli.mjs", label: "CLI entry" },
  { path: "backend/systemd/gptwork-mcp.service", label: "systemd unit" },
  { path: ".gptwork/runtime.env.example", label: "runtime env template" },
  { path: ".gptwork/project.md", label: "project context" },
];

const CHECK_FILES = [
  { path: "backend/node_modules", label: "node_modules (npm install)", isDir: true },
  { path: ".gptwork/runtime.env", label: "runtime.env (customized from example)", optional: true },
];

function header(label) {
  console.log(`\n--- ${label} ---`);
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-only");

  if (!checkOnly) {
    header("Creating required directories");
    for (const dir of REQUIRED_DIRS) {
      const fullPath = join(PROJECT_ROOT, dir);
      await mkdir(fullPath, { recursive: true });
      console.log(`  [OK] ${dir}`);
    }
  }

  header("Checking required files");
  let allRequiredPresent = true;
  for (const file of REQUIRED_FILES) {
    const fullPath = join(PROJECT_ROOT, file.path);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) throw new Error("not a file");
      console.log(`  [OK] ${file.label} (${file.path})`);
    } catch {
      console.error(`  [MISSING] ${file.label} (${file.path})`);
      allRequiredPresent = false;
    }
  }

  if (!allRequiredPresent) {
    console.error("\nFATAL: Required files missing. Ensure the repository is properly checked out.");
    process.exit(1);
  }

  header("Checking optional/verification files");
  for (const file of CHECK_FILES) {
    const fullPath = join(PROJECT_ROOT, file.path);
    if (file.optional) {
      if (existsSync(fullPath)) {
        console.log(`  [OK] ${file.label}`);
      } else {
        console.log(`  [INFO] ${file.label} — not yet configured (expected for fresh init)`);
      }
    } else {
      const exists = file.isDir ? existsSync(fullPath) : existsSync(fullPath) && stat(fullPath).then(s => s.isFile());
      if (existsSync(fullPath)) {
        console.log(`  [OK] ${file.label}`);
      } else {
        console.log(`  [INFO] ${file.label} — not present (run npm install first)`);
      }
    }
  }

  header("Environment check");
  const nodeVersion = process.version;
  console.log(`  Node.js: ${nodeVersion}`);
  if (parseInt(nodeVersion.slice(1).split(".")[0], 10) < 18) {
    console.error("  [WARN] Node.js >= 18 recommended");
  } else {
    console.log("  [OK] Node.js version meets minimum requirement");
  }

  header("Readiness");
  if (allRequiredPresent) {
    console.log("  Production baseline is ready.");
    console.log("  Next steps:");
    console.log("    1. Copy .gptwork/runtime.env.example -> .gptwork/runtime.env");
    console.log("    2. Edit .gptwork/runtime.env with production values");
    console.log("    3. Start: node src/cli.mjs");
    process.exit(0);
  } else {
    console.error("  Production baseline is NOT ready. Fix missing files above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
