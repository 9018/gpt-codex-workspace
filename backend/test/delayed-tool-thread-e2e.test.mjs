import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCatalog, normalizeToolDescriptor } from '../src/tool-discovery/tool-catalog.mjs';
import { createToolDiscoveryToolsGroup } from '../src/tool-groups/tool-discovery-tools-group.mjs';
import { createToolCapabilityRegistry } from '../src/ephemeral-execution/tool-capability-registry.mjs';
import { resolveRootGoal, buildThreadView } from '../src/thread/thread-view.mjs';

function fakeTool(descriptionOrDescriptor) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return {
      description: descriptionOrDescriptor.description,
      inputSchema: descriptionOrDescriptor.inputSchema,
      handler: descriptionOrDescriptor.handler,
      metadata: descriptionOrDescriptor.metadata || {},
    };
  }
  return { description: descriptionOrDescriptor, inputSchema: {}, handler: () => {}, metadata: {} };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

const SAMPLE_TOOLS = {
  health_check: {
    description: 'Health check endpoint',
    inputSchema: {},
    handler: () => 'ok',
    metadata: { name: 'health_check', tags: ['system'], audience: ['chatgpt'], modes: ['full'] },
  },
  runtime_status: {
    description: 'Runtime diagnostics',
    inputSchema: {},
    handler: () => 'running',
    metadata: { name: 'runtime_status', tags: ['system'], audience: ['chatgpt'], modes: ['full'] },
  },
  create_goal: {
    description: 'Create a new goal',
    inputSchema: {},
    handler: () => 'goal created',
    metadata: { name: 'create_goal', tags: ['workflow'], audience: ['chatgpt'], modes: ['standard'], annotations: { side_effect: 'mutates', idempotency: 'not_idempotent', authority: 'task' } },
  },
  tool_search: {
    description: 'Search tools',
    inputSchema: {},
    handler: () => [],
    metadata: { name: 'tool_search', tags: ['system', 'discovery'], audience: ['chatgpt'], modes: ['full'], annotations: { side_effect: 'none', idempotency: 'idempotent', execution_class: 'ephemeral_eligible' } },
  },
};

test('E2E: search -> describe -> capability registry integration', async () => {
  const catalog = createToolCatalog(SAMPLE_TOOLS);

  // Step 1: Search for tools
  const searchResults = catalog.search('goal', { audience: 'chatgpt' });
  assert.ok(searchResults.length >= 1);
  assert.equal(searchResults[0].name, 'create_goal');
  assert.equal(searchResults[0].handler, undefined);

  // Step 2: Describe specific tool
  const desc = catalog.get('create_goal');
  assert.ok(desc);
  assert.equal(desc.metadata.side_effect, 'mutates');
  assert.equal(desc.metadata.authority, 'task');

  // Step 3: Feed catalog descriptors into capability registry
  const registry = createToolCapabilityRegistry();
  registry.registerFromDescriptors(catalog.list());

  // Verify health_check (READ_ONLY) preserved its default despite catalog entry
  const healthMeta = registry.get('health_check');
  assert.equal(healthMeta.side_effect, 'none');
  assert.equal(healthMeta.execution_class, 'ephemeral_eligible');

  // create_goal gets its annotations from catalog descriptor
  const goalMeta = registry.get('create_goal');
  assert.equal(goalMeta.side_effect, 'mutates');
  assert.equal(goalMeta.authority, 'task');

  // Unknown tool gets UNKNOWN defaults
  const unknown = registry.get('nonexistent');
  assert.equal(unknown.side_effect, 'unknown');
  assert.equal(unknown.authority, null);
});

test('E2E: discovery tools group with live catalog', async () => {
  const catalog = createToolCatalog(SAMPLE_TOOLS);
  const tools = createToolDiscoveryToolsGroup({ tool: fakeTool, schema: fakeSchema, catalog });

  // tool_search works
  const searchResult = await tools.tool_search.handler({ query: 'health', include_schema: false });
  assert.ok(searchResult.tools.length >= 1);
  assert.equal(searchResult.tools[0].name, 'health_check');
  assert.equal(searchResult.tools[0].handler, undefined);

  // tool_describe works
  const describeResult = await tools.tool_describe.handler({ names: 'health_check,create_goal,nonexistent', include_schema: true });
  assert.equal(describeResult.found, 2);
  assert.equal(describeResult.not_found.length, 1);
  assert.equal(describeResult.not_found[0], 'nonexistent');
});

test('E2E: root goal -> repair child -> stable thread view', () => {
  const state = {
    goals: [
      {
        id: 'goal_root',
        root_goal_id: 'goal_root',
        title: 'Implement billing feature',
        user_request: 'Add billing support',
        status: 'assigned',
        mode: 'full',
      },
      {
        id: 'goal_repair_1',
        root_goal_id: 'goal_root',
        title: 'Repair: Implement billing feature (attempt 1)',
        user_request: 'Repair billing implementation',
        status: 'assigned',
        mode: 'repair',
        attempt: 1,
        parent_task_id: 'task_root',
        repair_of_goal_id: 'goal_root',
        failure_class: 'test_failed',
      },
      {
        id: 'goal_repair_2',
        root_goal_id: 'goal_root',
        title: 'Repair: Implement billing feature (attempt 2)',
        user_request: 'Second repair attempt',
        status: 'assigned',
        mode: 'repair',
        attempt: 2,
        parent_task_id: 'task_root',
        repair_of_goal_id: 'goal_root',
        failure_class: 'verification_failed',
      },
    ],
  };

  // Root goal thread view
  const rootView = buildThreadView(state, state.goals[0]);
  assert.equal(rootView.thread_id, 'goal_root');
  assert.equal(rootView.thread_title, 'Implement billing feature');
  assert.equal(rootView.internal_title, 'Implement billing feature');
  assert.equal(rootView.is_internal_child, false);
  assert.equal(rootView.iteration, 0);

  // Repair attempt 1
  const repair1View = buildThreadView(state, state.goals[1]);
  assert.equal(repair1View.thread_id, 'goal_root');
  assert.equal(repair1View.thread_title, 'Implement billing feature');
  assert.equal(repair1View.internal_title, 'Repair: Implement billing feature (attempt 1)');
  assert.equal(repair1View.is_internal_child, true);
  assert.equal(repair1View.iteration, 1);

  // Repair attempt 2
  const repair2View = buildThreadView(state, state.goals[2]);
  assert.equal(repair2View.thread_id, 'goal_root');
  assert.equal(repair2View.thread_title, 'Implement billing feature');
  assert.equal(repair2View.internal_title, 'Repair: Implement billing feature (attempt 2)');
  assert.equal(repair2View.is_internal_child, true);
  assert.equal(repair2View.iteration, 2);

  // resolveRootGoal for each
  assert.equal(resolveRootGoal(state, state.goals[0]).id, 'goal_root');
  assert.equal(resolveRootGoal(state, state.goals[1]).id, 'goal_root');
  assert.equal(resolveRootGoal(state, state.goals[2]).id, 'goal_root');
});

test('E2E: legacy goal without root_goal_id defaults to self', () => {
  const state = {
    goals: [
      {
        id: 'goal_legacy',
        title: 'Old goal',
        user_request: 'Do something before root_goal_id existed',
        status: 'completed',
        mode: 'full',
      },
    ],
  };

  const view = buildThreadView(state, state.goals[0]);
  assert.equal(view.thread_id, 'goal_legacy');
  assert.equal(view.root_goal_id, 'goal_legacy');
  assert.equal(view.thread_title, 'Old goal');
  assert.equal(view.is_internal_child, false);
});

test('E2E: catalog never exposes handlers even after registry integration', () => {
  const catalog = createToolCatalog(SAMPLE_TOOLS);
  const all = catalog.list();
  for (const d of all) {
    assert.equal(d.handler, undefined, `${d.name} must not expose handler`);
  }

  const registry = createToolCapabilityRegistry();
  registry.registerFromDescriptors(all);
  // Registry should not have handlers either
  for (const d of all) {
    const cap = registry.get(d.name);
    assert.equal(cap.handler, undefined);
  }
});

test('E2E: tool_search respects audience filter end-to-end', async () => {
  const catalog = createToolCatalog(SAMPLE_TOOLS);
  const tools = createToolDiscoveryToolsGroup({ tool: fakeTool, schema: fakeSchema, catalog });

  // filter by audience
  const chatgptTools = await tools.tool_search.handler({ query: '', audience: 'chatgpt' });
  assert.ok(chatgptTools.tools.every(t => t.audience.includes('chatgpt')));

  // no audience filter returns all
  const allTools = await tools.tool_search.handler({ query: '' });
  assert.equal(allTools.count, Object.keys(SAMPLE_TOOLS).length);
});
