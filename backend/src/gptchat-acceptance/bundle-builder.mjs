/**
 * bundle-builder.mjs — Create structured acceptance bundle zips for GPTChat.
 *
 * Collects task artifacts (result.json, verification, reports, changed files,
 * acceptance contract) into a portable zip that GPTChat can download, inspect,
 * and use to verify acceptance.
 *
 * The bundle structure:
 *   acceptance-bundle/
 *     manifest.json              — Bundle metadata and file inventory
 *     task-summary.md            — Human-readable task summary
 *     result.json                — Raw task result
 *     verification.json          — Verification report
 *     acceptance.contract.json   — Acceptance contract
 *     acceptance.evidence.json   — Standardized evidence (if present)
 *     changed/                   — Copy of all changed files
 *     docs/                      — Relevant documentation (if any)
 *     logs/                      — Verification logs (if any)
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { runZipCommand } from '../workspace-zip-runner.mjs';

const BUNDLE_VERSION = 1;


function resolveWorkspacePath(root, filePath) {
  if (!filePath) return null;
  return isAbsolute(filePath) ? filePath : join(root || process.cwd(), filePath);
}

/**
 * Build an acceptance bundle zip from task artifacts.
 *
 * @param {object} options
 * @param {string} [options.goalDir] - Path to the goal directory (.gptwork/goals/<goal_id>)
 * @param {object} [options.bundle] - Pre-loaded acceptance bundle (from task-acceptance-bundle.mjs)
 * @param {string} [options.repoPath] - Canonical or worktree repo path
 * @param {string[]} [options.changedFiles] - List of changed files to include
 * @param {string} [options.outputPath] - Output zip path (defaults to <goalDir>/acceptance-bundle.zip)
 * @param {number} [options.maxBytes] - Max bundle size (default 25MB)
 * @returns {Promise<{ bundlePath: string, bundleSha256: string, fileCount: number, size: number, errors: string[] }>}
 */
export async function buildAcceptanceBundle({
  goalDir,
  bundle,
  repoPath,
  changedFiles = [],
  outputPath,
  maxBytes = 25 * 1024 * 1024,
} = {}) {
  const errors = [];
  const tmpRoot = await mkdtemp(join(tmpdir(), 'gptwork-acceptance-bundle-'));
  const stagingDir = join(tmpRoot, 'acceptance-bundle');
  await mkdir(stagingDir, { recursive: true });
  const manifestFiles = [];

  // 1. Collect manifest data
  const manifestData = {
    bundle_version: BUNDLE_VERSION,
    created_at: new Date().toISOString(),
    source: {},
    file_inventory: [],
  };

  // 2. Copy core artifacts from goal directory
  if (goalDir && existsSync(goalDir)) {
    const coreFiles = [
      'result.json', 'verification.json', 'acceptance.contract.json',
      'result.md', 'acceptance.json', 'acceptance.evidence.json',
    ];
    for (const fileName of coreFiles) {
      const src = join(goalDir, fileName);
      if (existsSync(src)) {
        const dst = join(stagingDir, fileName);
        try {
          await cp(src, dst);
          manifestFiles.push({ path: fileName, source: 'goal_dir' });
        } catch (err) {
          errors.push(`Failed to copy ${fileName}: ${err.message}`);
        }
      }
    }

    // Read result.json for source attribution
    const resultJsonPath = join(goalDir, 'result.json');
    if (existsSync(resultJsonPath)) {
      try {
        const result = JSON.parse(await readFile(resultJsonPath, 'utf8'));
        manifestData.source = {
          task_id: result.task_id || bundle?.task_id || null,
          goal_id: result.goal_id || bundle?.goal_id || null,
          status: result.status || null,
          commit: result.commit || null,
          operation_kind: result.operation_kind || null,
          summary: result.summary || null,
        };
      } catch {
        // non-fatal
      }
    }
  }

  // 3. Include pre-compacted bundle data as JSON if provided
  if (bundle) {
    const compactPath = join(stagingDir, 'acceptance-bundle.compact.json');
    await writeFile(compactPath, JSON.stringify(bundle, null, 2), 'utf8');
    manifestFiles.push({ path: 'acceptance-bundle.compact.json', source: 'compact_bundle' });

    // Fill source from bundle if not already filled
    if (!manifestData.source.task_id) {
      manifestData.source = {
        task_id: bundle.task_id || null,
        goal_id: bundle.goal_id || null,
        title: bundle.title || null,
        status: bundle.status || null,
        operation_kind: bundle.operation_kind || null,
      };
    }
  }

  // 4. Write human-readable task summary
  const summaryLines = [];
  if (manifestData.source) {
    summaryLines.push(`# Acceptance Bundle: ${manifestData.source.title || manifestData.source.task_id || 'Unknown Task'}`);
    summaryLines.push('');
    summaryLines.push(`- **Task ID**: ${manifestData.source.task_id || 'N/A'}`);
    summaryLines.push(`- **Goal ID**: ${manifestData.source.goal_id || 'N/A'}`);
    summaryLines.push(`- **Status**: ${manifestData.source.status || 'N/A'}`);
    summaryLines.push(`- **Operation Kind**: ${manifestData.source.operation_kind || 'N/A'}`);
    summaryLines.push(`- **Commit**: ${manifestData.source.commit || 'N/A'}`);
    summaryLines.push(`- **Created**: ${manifestData.created_at}`);
    summaryLines.push('');
    if (manifestData.source.summary) {
      summaryLines.push('## Task Summary');
      summaryLines.push('');
      summaryLines.push(manifestData.source.summary);
      summaryLines.push('');
    }
  }
  if (bundle) {
    if (bundle.changed_files?.length) {
      summaryLines.push('## Changed Files');
      summaryLines.push('');
      for (const file of bundle.changed_files) {
        summaryLines.push(`- ${file}`);
      }
      summaryLines.push('');
    }
    if (bundle.blockers?.length) {
      summaryLines.push('## Blockers');
      summaryLines.push('');
      for (const blocker of bundle.blockers) {
        summaryLines.push(`- [${blocker.severity}] ${blocker.code}: ${blocker.message}`);
      }
      summaryLines.push('');
    }
    if (bundle.non_blocking_followups?.length) {
      summaryLines.push('## Follow-ups / Non-blocking Items');
      summaryLines.push('');
      for (const item of bundle.non_blocking_followups) {
        summaryLines.push(`- ${item.message || item.code || JSON.stringify(item)}`);
      }
      summaryLines.push('');
    }
    if (bundle.verification?.commands?.length) {
      summaryLines.push('## Verification Commands');
      summaryLines.push('');
      for (const cmd of bundle.verification.commands) {
        const cmdStr = cmd.cmd || cmd.command || '(unknown)';
        const exitCode = cmd.exit_code;
        const passed = cmd.passed;
        summaryLines.push(`- \`${cmdStr}\` → exit=${exitCode} passed=${passed}`);
      }
      summaryLines.push('');
    }
  }
  await writeFile(join(stagingDir, 'task-summary.md'), summaryLines.join('\n'), 'utf8');
  manifestFiles.push({ path: 'task-summary.md', source: 'generated' });

  // 5. Copy changed files
  const resolvedChangedFiles = changedFiles.length > 0
    ? changedFiles
    : (bundle?.changed_files || []);
  if (resolvedChangedFiles.length > 0 && repoPath) {
    const changedDir = join(stagingDir, 'changed');
    await mkdir(changedDir, { recursive: true });
    for (const filePath of resolvedChangedFiles) {
      const srcPath = join(repoPath, filePath);
      if (existsSync(srcPath)) {
        const dstPath = join(changedDir, filePath);
        try {
          await mkdir(dirname(dstPath), { recursive: true });
          await cp(srcPath, dstPath);
          manifestFiles.push({ path: `changed/${filePath}`, source: 'changed_file' });
        } catch (err) {
          errors.push(`Failed to copy changed file ${filePath}: ${err.message}`);
        }
      }
    }
  }

  // 6. Copy report artifacts from bundle paths
  if (bundle?.report_paths) {
    for (const [key, relPath] of Object.entries(bundle.report_paths)) {
      if (typeof relPath !== 'string' || !relPath) continue;
      const absPath = resolve(relPath);
      if (existsSync(absPath)) {
        const ext = relPath.endsWith('.json') ? '.json' : relPath.endsWith('.md') ? '.md' : '.txt';
        const dstName = `report-${key}${ext}`;
        const dstPath = join(stagingDir, dstName);
        try {
          await cp(absPath, dstPath);
          manifestFiles.push({ path: dstName, source: `report:${key}` });
        } catch (err) {
          errors.push(`Failed to copy report ${key}: ${err.message}`);
        }
      }
    }
  }

  // 7. Write manifest
  manifestData.file_inventory = manifestFiles;
  manifestData.file_count = manifestFiles.length;
  manifestData.errors = errors;
  await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

  // 8. Create zip
  const bundlePath = outputPath || (goalDir
    ? join(goalDir, 'acceptance-bundle.zip')
    : join(tmpRoot, 'acceptance-bundle.zip'));
  await mkdir(dirname(bundlePath), { recursive: true });

  try {
    await runZipCommand('create', stagingDir, bundlePath);
  } catch (err) {
    // Fallback to direct zipfile creation via python script
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const script = [
      'import zipfile, os, sys',
      'src = sys.argv[1]',
      'dst = sys.argv[2]',
      'with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:',
      '    for root, dirs, files in os.walk(src):',
      '        for fn in files:',
      '            path = os.path.join(root, fn)',
      '            zf.write(path, os.path.relpath(path, src))',
    ].join('\n');
    await execFileAsync(pythonCmd, ['-c', script, stagingDir, bundlePath], { timeout: 60000 });
  }

  // 9. Read bundle for SHA256 and size
  const bundleBytes = await readFile(bundlePath);
  const { createHash } = await import('node:crypto');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  const fileCount = manifestFiles.length;

  // 10. Cleanup temp
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  return {
    bundlePath,
    bundleSha256,
    fileCount,
    size: bundleBytes.length,
    errors,
  };
}

/**
 * Build acceptance bundle from a stored task acceptance bundle object.
 */
export async function buildAcceptanceBundleFromTask({ bundle, store, config } = {}) {
  if (!bundle?.task_id) throw new Error('task_id is required in bundle for bundle building');

  const { goalWorkspaceFiles } = await import('../goal-files.mjs');
  const { ensureGoalState } = await import('../task-lifecycle.mjs');

  const state = await store.load();
  ensureGoalState(state);
  const goal = bundle.goal_id
    ? state.goals.find((g) => g.id === bundle.goal_id)
    : state.goals.find((g) => g.task_id === bundle.task_id);
  const files = goal ? goalWorkspaceFiles(goal) : {};
  const workspaceRoot = goal?.workspace_root || config.defaultWorkspaceRoot || config.workspaceRoot || process.cwd();
  const goalDir = files.dir ? resolveWorkspacePath(workspaceRoot, files.dir) : null;

  return buildAcceptanceBundle({
    goalDir,
    bundle,
    changedFiles: bundle.changed_files || [],
    repoPath: config.defaultRepoPath || config.canonicalRepoPath || config.defaultWorkspaceRoot || process.cwd(),
  });
}
