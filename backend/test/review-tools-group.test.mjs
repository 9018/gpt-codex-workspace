/**
 * review-tools-group.test.mjs — Tests for Actionable Review Query Tool.
 *
 * Coverage:
 * - Tool group structure and schema
 * - Current actionable reviews vs historical resolved reviews classification
 * - Empty state and populated state
 * - include_historical flag behavior
 * - Truncation handling
 * - Review item fields completeness
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewToolsGroup, collectActionableReviews } from '../src/tool-groups/review-tools-group.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === 'object' && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler, metadata: descriptionOrDescriptor };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

/** Build a mock task with given overrides. */
function makeTask(overrides = {}) {
  return {
    id: overrides.id || 'task_default',
    status: overrides.status || 'waiting_for_review',
    assignee: overrides.assignee || 'codex',
    title: overrides.title || 'Test Task',
    goal_id: overrides.goal_id || 'goal_default',
    created_at: overrides.created_at || '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at || '2026-01-01T01:00:00Z',
    result: overrides.result || null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool group: structural tests
// ---------------------------------------------------------------------------

test('review tools group exposes list_actionable_reviews tool', () => {
  const tools = createReviewToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { load: async () => ({ tasks: [] }) },
    config: {},
  });

  const toolNames = Object.keys(tools).sort();
  assert.deepEqual(toolNames, ['list_actionable_reviews']);
});

test('list_actionable_reviews has correct input schema', () => {
  const tools = createReviewToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { load: async () => ({ tasks: [] }) },
    config: {},
  });

  const tool = tools.list_actionable_reviews;
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 20);
  assert.deepEqual(tool.inputSchema.required, []);

  const props = tool.inputSchema.properties;
  assert.equal(typeof props.include_historical, 'object');
  assert.equal(props.include_historical.type, 'boolean');
  assert.equal(typeof props.max_items, 'object');
  assert.equal(props.max_items.type, 'integer');
});

test('list_actionable_reviews has card output template', () => {
  const tools = createReviewToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { load: async () => ({ tasks: [] }) },
    config: {},
  });

  const metadata = tools.list_actionable_reviews.metadata;
  assert.ok(metadata);
  assert.equal(metadata.outputTemplate, 'ui://widget/gptwork-tool-card-v5.html');
  assert.ok(metadata.tags.includes('review'));
  assert.ok(metadata.audience.includes('chatgpt'));
});

// ---------------------------------------------------------------------------
// collectActionableReviews: core logic tests
// ---------------------------------------------------------------------------

test('collectActionableReviews: empty state returns zero counts', async () => {
  const mockStore = { load: async () => ({ tasks: [] }) };
  const result = await collectActionableReviews(mockStore);

  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.historical_resolved_reviews, 0);
  assert.equal(result.counts.total_codex_review_tasks, 0);
  assert.equal(result.current_reviews.length, 0);
  assert.equal(result.truncated, false);
  assert.ok(result.scanned_at);
});

test('collectActionableReviews: non-codex tasks are excluded', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_review', assignee: 'human' }),
        makeTask({ id: 't2', status: 'waiting_for_review', assignee: 'chatgpt' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.total_codex_review_tasks, 0);
});

test('collectActionableReviews: completed tasks are excluded from review query', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'completed', assignee: 'codex' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.total_codex_review_tasks, 0);
});

test('collectActionableReviews: waiting_for_review task is a current actionable review', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({
          id: 't1',
          status: 'waiting_for_review',
          title: 'Fix queue retention',
          result: { summary: 'blocking findings', acceptance_findings: [{ code: 'changed_files_mismatch', severity: 'blocker' }] },
        }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 1);
  assert.equal(result.counts.total_codex_review_tasks, 1);
  assert.equal(result.current_reviews.length, 1);

  const item = result.current_reviews[0];
  assert.equal(item.task_id, 't1');
  assert.equal(item.title, 'Fix queue retention');
  assert.equal(item.status, 'waiting_for_review');
  assert.equal(typeof item.short_reason, 'string');
  assert.equal(typeof item.recommended_next_action, 'string');
  assert.equal(typeof item.safe_to_advance, 'boolean');
  assert.equal(item.blocker_codes.length, 1);
  assert.ok(item.blocker_codes.includes('changed_files_mismatch'));
});

test('collectActionableReviews: historical resolved review is excluded from current by default', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({
          id: 't1',
          status: 'waiting_for_review',
          result: { resolved_by_task_id: 't_resolver', superseded_by_task_id: 't_resolver' },
        }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  // resolved_by_task_id makes it resolved → not a current blocker
  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.historical_resolved_reviews, 1);
  assert.equal(result.current_reviews.length, 0);
});

test('collectActionableReviews: include_historical returns historical items', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_review', result: { resolved_by_task_id: 't_resolver', superseded_by_task_id: 't_resolver' } }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore, { include_historical: true });
  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.historical_resolved_reviews, 1);
  assert.ok(Array.isArray(result.historical_reviews));
  assert.equal(result.historical_reviews.length, 1);
  assert.equal(result.historical_reviews[0].task_id, 't1');
  assert.equal(result.historical_reviews[0].is_resolved, true);
});

test('collectActionableReviews: review item has all required fields', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({
          id: 'task_abc123',
          status: 'waiting_for_human_required',
          title: 'Typed review test',
          goal_id: 'goal_xyz',
          result: {
            acceptance_findings: [
              { code: 'policy_uncertain', severity: 'blocker' },
              { code: 'context_missing', severity: 'blocker' },
            ],
          },
        }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 1);
  const item = result.current_reviews[0];

  // All required fields per spec
  assert.equal(item.task_id, 'task_abc123');
  assert.equal(item.goal_id, 'goal_xyz');
  assert.equal(item.title, 'Typed review test');
  assert.equal(item.status, 'waiting_for_human_required');
  assert.equal(typeof item.short_reason, 'string');
  assert.ok(item.short_reason.length > 0);
  assert.ok(Array.isArray(item.blocker_codes));
  assert.ok(item.blocker_codes.length >= 2);
  assert.equal(typeof item.recommended_next_action, 'string');
  assert.equal(typeof item.safe_to_advance, 'boolean');
  assert.equal(item.safe_to_advance, false); // human_required is NOT safe
  assert.equal(item.is_resolved, false);
  assert.equal(item.resolved_by_task_id, null);
  assert.equal(item.superseded_by_task_id, null);
});

test('collectActionableReviews: machine-repairable review is safe to advance', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_evidence_missing', title: 'Auto-fix me' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 1);
  const item = result.current_reviews[0];
  assert.equal(item.safe_to_advance, true);
  assert.ok(['auto_repair', 'auto_resolve'].includes(item.recommended_next_action));
});

test('collectActionableReviews: waiting_for_integration is current and safe', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_integration', title: 'Integrate me' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 1);
  const item = result.current_reviews[0];
  assert.equal(item.safe_to_advance, true);
  assert.equal(item.recommended_next_action, 'auto_integrate');
});

test('collectActionableReviews: failed task with no resolution is a current review', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'failed', title: 'Failed build', result: { failure_class: 'verification_failed' } }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 1);
  const item = result.current_reviews[0];
  assert.equal(item.safe_to_advance, false);
  assert.equal(item.recommended_next_action, 'triage_failure');
});

test('collectActionableReviews: truncation works at configurable max_items', async () => {
  const tasks = [];
  for (let i = 0; i < 100; i++) {
    tasks.push(makeTask({ id: `t_${i}`, status: 'waiting_for_review', title: `Task ${i}` }));
  }
  const mockStore = { load: async () => ({ tasks }) };
  const result = await collectActionableReviews(mockStore, { max_items: 3 });
  assert.equal(result.current_reviews.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.current_actionable_reviews, 100);
});

test('collectActionableReviews: counts summary is accurate with mixed tasks', async () => {
  const tasks = [
    // Current review - unresolved review
    makeTask({ id: 't1', status: 'waiting_for_review', title: 'Current review 1' }),
    // Current review - typed
    makeTask({ id: 't2', status: 'waiting_for_human_required', title: 'Human required' }),
    // Current review - machine repairable
    makeTask({ id: 't3', status: 'waiting_for_evidence_missing', title: 'Missing evidence' }),
    // Current - repair
    makeTask({ id: 't4', status: 'waiting_for_repair', title: 'Needs repair' }),
    // Current - integration
    makeTask({ id: 't5', status: 'waiting_for_integration', title: 'Needs integration' }),
    // Historical resolved
    makeTask({ id: 't6', status: 'waiting_for_review', result: { resolved_by_task_id: 't_resolver' } }),
    // Historical resolved (superseded)
    makeTask({ id: 't7', status: 'waiting_for_review', result: { superseded_by_task_id: 't_superseder' } }),
    // Non-codex (should be excluded from all counts)
    makeTask({ id: 't8', status: 'waiting_for_review', assignee: 'human' }),
  ];

  const mockStore = { load: async () => ({ tasks }) };
  const result = await collectActionableReviews(mockStore);

  assert.equal(result.counts.current_actionable_reviews, 5);
  assert.equal(result.counts.historical_resolved_reviews, 2);
  assert.equal(result.counts.total_codex_review_tasks, 7);
  assert.equal(result.counts.excluded_by_policy, 0);
  assert.equal(result.current_reviews.length, 5);
});

test('collectActionableReviews: safe_to_advance is false for human_required states', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_human_required' }),
        makeTask({ id: 't2', status: 'waiting_for_human_review' }),
        makeTask({ id: 't3', status: 'waiting_for_manual_terminal_decision' }),
        makeTask({ id: 't4', status: 'waiting_for_repair_budget_exhausted' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 4);
  for (const item of result.current_reviews) {
    assert.equal(item.safe_to_advance, false, `${item.task_id} (${item.status}) should NOT be safe to advance`);
  }
});

test('collectActionableReviews: use existing classifier for machine_repairable states', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({ id: 't1', status: 'waiting_for_provider_unavailable' }),
        makeTask({ id: 't2', status: 'waiting_for_evidence_missing' }),
        makeTask({ id: 't3', status: 'waiting_for_integration_uncertain' }),
        makeTask({ id: 't4', status: 'waiting_for_integration_recovery' }),
        makeTask({ id: 't5', status: 'waiting_for_noop_evidence' }),
        makeTask({ id: 't6', status: 'waiting_for_missing_evidence_repair' }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  assert.equal(result.counts.current_actionable_reviews, 6);
  for (const item of result.current_reviews) {
    assert.equal(item.safe_to_advance, true, `${item.task_id} (${item.status}) should be safe to advance`);
  }
});

test('collectActionableReviews: superseded markers appear in item', async () => {
  const mockStore = {
    load: async () => ({
      tasks: [
        makeTask({
          id: 't_legacy',
          status: 'waiting_for_review',
          result: { superseded_by_task_id: 't_new_version' },
        }),
      ],
    }),
  };
  const result = await collectActionableReviews(mockStore);
  // Should be historical (superseded)
  assert.equal(result.counts.current_actionable_reviews, 0);
  assert.equal(result.counts.historical_resolved_reviews, 1);

  // Now check with include_historical
  const result2 = await collectActionableReviews(mockStore, { include_historical: true });
  const item = result2.historical_reviews[0];
  assert.equal(item.superseded_by_task_id, 't_new_version');
  assert.equal(item.is_resolved, true);
});

console.log('review-tools-group tests loaded');
