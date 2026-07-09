#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

async function run(name, cmd, args, cwd) {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  return { name, stdout, stderr };
}

async function main() {
  const repo = join(__dirname, '..');
  const checks = [];
  checks.push(await run('syntax', 'npm', ['run', 'check:syntax'], repo).catch((err) => ({ name: 'syntax', error: err.message })));
  checks.push(await run('imports', 'node', ['-e', 'Promise.all([import("./src/stage-invocation-contract.mjs"), import("./src/stage-loop-service.mjs"), import("./src/goal-worktree-service.mjs"), import("./src/evidence-bundle-service.mjs"), import("./src/merge-gate-service.mjs"), import("./src/tui-first-loop-orchestrator.mjs"), import("./src/product-loop-status-view.mjs"), import("./src/goal-workspace-status.mjs"), import("./src/goal-branch-service.mjs"), import("./src/acceptance-contract-service.mjs"), import("./src/acceptance-result-normalizer.mjs"), import("./src/merge-decision-service.mjs"), import("./src/providers/claude-tui-goal-provider.mjs"), import("./src/providers/codex-tui-accept-provider.mjs"), import("./src/providers/claude-exec-advance-provider.mjs"), import("./src/tool-groups/goal-merge-tools-group.mjs")]).then(() => console.log("imports ok")).catch(e => { console.error(e); process.exit(1); })'], repo).catch((err) => ({ name: 'imports', error: err.message })));
  checks.push(await run('e2e:tui-first-loop', 'node', ['scripts/e2e-tui-first-loop.mjs'], repo).catch((err) => ({ name: 'e2e:tui-first-loop', error: err.message })));
  const ok = checks.every((c) => !c.error);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
