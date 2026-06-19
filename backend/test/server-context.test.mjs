import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOptionSourceOverrides, createServerContext } from '../src/server-context.mjs';

test('applyOptionSourceOverrides marks explicit options as options source', () => {
  const sources = { workspaceRoot: 'process.env', defaultRepo: 'runtime.env' };
  const result = applyOptionSourceOverrides(sources, {
    defaultWorkspaceRoot: '/tmp/workspace',
    codexExecTimeout: 10,
    defaultRepo: '9018/gpt-codex-workspace',
  });

  assert.equal(result, sources);
  assert.equal(result.workspaceRoot, 'options');
  assert.equal(result.codexExecTimeout, 'options');
  assert.equal(result.defaultRepo, 'options');
});

test('applyOptionSourceOverrides ignores absent options', () => {
  const sources = { workspaceRoot: 'process.env' };
  applyOptionSourceOverrides(sources, {});
  assert.deepEqual(sources, { workspaceRoot: 'process.env' });
});

test('createServerContext preserves explicit dependency references', () => {
  const deps = {
    config: { defaultWorkspaceRoot: '/tmp/workspace' },
    store: { kind: 'store' },
    browser: { kind: 'browser' },
    github: { kind: 'github' },
    bark: { kind: 'bark' },
    barkConfigSource: 'options',
    envLoadResult: { loaded: true },
    earlyEnvResult: { loaded: false },
  };

  const context = createServerContext(deps);
  assert.deepEqual(context, deps);
  assert.equal(context.config, deps.config);
  assert.equal(context.store, deps.store);
});
