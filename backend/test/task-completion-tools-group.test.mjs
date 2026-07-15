import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTaskCompletionReadiness, createTaskCompletionToolsGroup } from '../src/tool-groups/task-completion-tools-group.mjs';

function fakeTool(descriptionOrDescriptor, inputSchema, handler) {
  if (descriptionOrDescriptor && typeof descriptionOrDescriptor === "object" && !Array.isArray(descriptionOrDescriptor)) {
    return { description: descriptionOrDescriptor.description, inputSchema: descriptionOrDescriptor.inputSchema, handler: descriptionOrDescriptor.handler };
  }
  return { description: descriptionOrDescriptor, inputSchema, handler };
}

function fakeSchema(shape = {}, required = []) {
  return { type: 'object', properties: shape, required };
}

test('task completion tool group exposes stable public tool names and schemas', () => {
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    github: { syncTask: async () => {} },
  });

  assert.deepEqual(Object.keys(tools), [
    'complete_task',
    'request_human_review',
  ]);

  // complete_task: required = ['task_id'], optional = ['summary', 'admin_override']
  assert.deepEqual(tools.complete_task.inputSchema.required, ['task_id']);
  assert.equal(tools.complete_task.inputSchema.properties.task_id, 'string');
  assert.equal(tools.complete_task.inputSchema.properties.summary, 'string');
  assert.equal(tools.complete_task.inputSchema.properties.admin_override, 'boolean');

  // request_human_review: required = ['task_id'], optional = ['message']
  assert.deepEqual(tools.request_human_review.inputSchema.required, ['task_id']);
  assert.equal(tools.request_human_review.inputSchema.properties.task_id, 'string');
  assert.equal(tools.request_human_review.inputSchema.properties.message, 'string');
});

test('complete_task handler description matches expected text', () => {
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: {},
    github: { syncTask: async () => {} },
  });

  assert.match(tools.complete_task.description, /Mark a task completed/);
  assert.match(tools.request_human_review.description, /Mark a task as waiting for human review/);
});


test('strict acceptance tasks cannot complete without durable evidence', () => {
  const assessment = assessTaskCompletionReadiness({
    status: 'running',
    acceptance_contract: {
      blocking_requirements: [{ id: 'deployment_health' }],
      acceptance_policy: { fail_on_missing_evidence: true },
      verification_plan: { required_reports: ['health_check'] },
    },
    result: null,
  });

  assert.equal(assessment.ready, false);
  assert.deepEqual(assessment.missing, ['result', 'verification', 'contract_verification']);
});

test('strict acceptance tasks complete only when result and verification evidence pass', () => {
  const assessment = assessTaskCompletionReadiness({
    status: 'accepting',
    acceptance_contract: {
      blocking_requirements: [{ id: 'deployment_health' }],
      acceptance_policy: { fail_on_missing_evidence: true },
    },
    result: { status: 'completed', summary: 'done' },
    verification: { passed: true, status: 'passed' },
    contract_verification: { passed: true, status: 'passed' },
  });

  assert.equal(assessment.ready, true);
  assert.deepEqual(assessment.missing, []);
});


test('strict acceptance recognizes canonical contract verification schema', () => {
  const assessment = assessTaskCompletionReadiness({
    acceptance_contract: { acceptance_policy: { fail_on_missing_evidence: true } },
    result: {
      status: 'completed',
      verification: { passed: true, status: 'passed' },
      contract_verification: {
        contract_valid: true,
        blocking_passed: true,
        completion_eligible: true,
        requires_review: false,
      },
    },
  });

  assert.equal(assessment.ready, true);
  assert.deepEqual(assessment.missing, []);
});

test('complete_task routes status changes through the canonical transition service', async () => {
  const task = {
    id: 'task_transition_complete',
    status: 'accepting',
    result: { status: 'completed', summary: 'verified' },
  };
  const calls = [];
  const transitionService = {
    async transitionTask(command) {
      calls.push(command);
      task.status = command.payload.canonical_status;
      task.result = { ...task.result, ...command.payload.task_result_patch };
      return { task, applied: true, next_status: task.status };
    },
  };
  const store = {
    state: { tasks: [task], goals: [] },
    async load() { return this.state; },
    async findTaskById(id) { return this.state.tasks.find((item) => item.id === id); },
  };
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store,
    github: { syncTask: async () => {} },
    transitionService,
  });

  const result = await tools.complete_task.handler({ task_id: task.id, summary: 'done' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'canonical_decision_applied');
  assert.equal(calls[0].payload.canonical_status, 'completed');
  assert.equal(calls[0].payload.unified_decision.status, 'completed');
  assert.equal(result.task.status, 'completed');
});

test('request_human_review routes through canonical transition service', async () => {
  const task = { id: 'task_transition_review', status: 'accepting', result: {} };
  const calls = [];
  const transitionService = {
    async transitionTask(command) {
      calls.push(command);
      task.status = command.payload.canonical_status;
      task.result = { ...task.result, ...command.payload.task_result_patch };
      return { task, applied: true, next_status: task.status };
    },
  };
  const tools = createTaskCompletionToolsGroup({
    tool: fakeTool,
    schema: fakeSchema,
    store: { async load() { return { tasks: [task] }; } },
    github: { syncTask: async () => {} },
    transitionService,
  });

  const result = await tools.request_human_review.handler({ task_id: task.id, message: 'inspect evidence' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'canonical_decision_applied');
  assert.equal(calls[0].payload.canonical_status, 'waiting_for_review');
  assert.equal(calls[0].payload.task_result_patch.review_message, 'inspect evidence');
  assert.equal(result.task.status, 'waiting_for_review');
});

test('strict completion rejects passed evidence when canonical outcome still requires repair', () => {
  const assessment = assessTaskCompletionReadiness({
    acceptance_contract: { acceptance_policy: { fail_on_missing_evidence: true } },
    result: {
      status: 'completed',
      verification: { passed: true },
      contract_verification: { passed: true },
      unified_decision: { status: 'waiting_for_repair', safe_to_auto_advance: false, requires_repair: true },
    },
  });
  assert.equal(assessment.ready, false);
  assert.ok(assessment.missing.includes('canonical_outcome'));
});

test('strict completion rejects missing or failed reviewer decision when pipeline requires reviewer', () => {
  const assessment = assessTaskCompletionReadiness({
    require_pipeline_gates: true,
    acceptance_contract: { acceptance_policy: { fail_on_missing_evidence: true } },
    result: {
      status: 'completed',
      verification: { passed: true },
      contract_verification: { passed: true },
      pipeline_gate: { blocked: true, reasons: ['reviewer: missing required artifacts (reviewer_decision)'] },
    },
  });
  assert.equal(assessment.ready, false);
  assert.ok(assessment.missing.includes('pipeline_gate'));
  assert.ok(assessment.missing.includes('reviewer_decision'));
});
