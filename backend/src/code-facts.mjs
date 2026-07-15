/**
 * code-facts.mjs
 *
 * Generates structured code facts (module index, exports catalog) from the
 * source tree. Used for code understanding, documentation generation, and
 * observability.
 *
 * Exports:
 *   scanSourceFiles(srcDir)       — walk dir recursively, return .mjs files
 *   collectExports(filePath)      — parse exports from a single file
 *   generateModuleIndex(srcDir)   — full catalog of all modules
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, basename, extname } from 'node:path';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// scanSourceFiles
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively and return all .mjs files.
 *
 * @param {string} dir — directory to scan
 * @returns {Promise<string[]>} sorted array of absolute file paths
 */
export async function scanSourceFiles(dir) {
  const files = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'coverage'].includes(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

// ---------------------------------------------------------------------------
// collectExports
// ---------------------------------------------------------------------------

/**
 * Parse exported function and class names from a single .mjs file.
 * Uses regex-based extraction (lightweight, no full AST).
 *
 * @param {string} filePath
 * @returns {Promise<string[]>} sorted array of export names
 */
export async function collectExports(filePath) {
  const exports = [];
  try {
    const content = await readFile(filePath, 'utf8');

    // Match: export function foo
    const funcRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
    let match;
    while ((match = funcRe.exec(content)) !== null) {
      exports.push(match[1]);
    }

    // Match: export class Foo
    const classRe = /export\s+class\s+(\w+)/g;
    while ((match = classRe.exec(content)) !== null) {
      exports.push(match[1]);
    }

    // Match: export const foo = ...
    const constRe = /export\s+(?:const|let|var)\s+(\w+)/g;
    while ((match = constRe.exec(content)) !== null) {
      exports.push(match[1]);
    }

    // Match: export { foo, bar }
    const namedRe = /export\s*\{\s*([^}]+)\s*\}/g;
    while ((match = namedRe.exec(content)) !== null) {
      const names = match[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      }).filter(Boolean);
      exports.push(...names);
    }

  } catch {
    // File not found or unreadable — empty result
  }

  return [...new Set(exports)].sort();
}

// ---------------------------------------------------------------------------
// generateModuleIndex
// ---------------------------------------------------------------------------

/**
 * Generate a structured module index catalog from a source directory.
 *
 * @param {string} srcDir — path to source directory
 * @returns {Promise<object>} catalog with modules array, generatedAt, stats
 */
export async function generateModuleIndex(srcDir) {
  const files = await scanSourceFiles(srcDir);
  const modules = [];
  let totalExports = 0;

  for (const filePath of files) {
    const exports = await collectExports(filePath);
    const relPath = relative(srcDir, filePath);
    modules.push({
      path: relPath,
      name: basename(filePath, extname(filePath)),
      exports,
      exportCount: exports.length,
    });
    totalExports += exports.length;
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceDir: srcDir,
    sourceCount: modules.length,
    totalExports,
    modules,
  };
}
