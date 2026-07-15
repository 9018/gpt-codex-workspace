import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Code Facts Generation', () => {
  let scanSourceFiles, generateModuleIndex, collectExports;

  before(async () => {
    const mod = await import('../src/code-facts.mjs');
    scanSourceFiles = mod.scanSourceFiles;
    generateModuleIndex = mod.generateModuleIndex;
    collectExports = mod.collectExports;
  });

  it('scanSourceFiles exists and returns Array', () => {
    assert.equal(typeof scanSourceFiles, 'function');
  });

  it('scanSourceFiles finds .mjs files in src/', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(__dirname, '../src');
    const files = await scanSourceFiles(srcDir);
    assert.ok(Array.isArray(files));
    assert.ok(files.length > 0);
    // All files should be .mjs
    for (const f of files) {
      assert.ok(f.endsWith('.mjs'), `Expected .mjs: ${f}`);
    }
  });

  it('collectExports extracts function and class names', async () => {
    // Use the code-facts module itself as test input
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const factPath = resolve(__dirname, '../src/code-facts.mjs');
    const exports = await collectExports(factPath);
    assert.ok(Array.isArray(exports));
    // Should find scanSourceFiles, generateModuleIndex, collectExports
    assert.ok(exports.includes('scanSourceFiles'));
    assert.ok(exports.includes('generateModuleIndex'));
    assert.ok(exports.includes('collectExports'));
  });

  it('generateModuleIndex produces structured catalog', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(__dirname, '../src');
    const catalog = await generateModuleIndex(srcDir);
    assert.ok(catalog);
    assert.equal(typeof catalog, 'object');
    assert.ok(Array.isArray(catalog.modules));
    assert.ok(catalog.modules.length > 0);

    // Check a module entry structure
    const entry = catalog.modules[0];
    assert.ok(entry.path);
    assert.ok(entry.name);
    assert.ok(Array.isArray(entry.exports));
  });

  it('catalog includes metadata', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(__dirname, '../src');
    const catalog = await generateModuleIndex(srcDir);
    assert.ok(catalog.generatedAt);
    assert.ok(catalog.sourceCount > 0);
    assert.ok(catalog.totalExports > 0);
  });
});
