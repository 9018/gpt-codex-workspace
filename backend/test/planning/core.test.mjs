import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanIr, computePlanIrDigest } from '../../src/planning/plan-ir-schema.mjs';
import { compilePlanIr } from '../../src/planning/plan-ir-compiler.mjs';
import { applyPlanIr } from '../../src/planning/plan-ir-applier.mjs';

const plan = { schema_version:'gptwork.plan_ir.v1', plan_id:'p1', workstream_id:'ws1', nodes:[
  {id:'inspect',kind:'ephemeral_batch',operation:{calls:[{call_id:'r',tool_name:'read_text_file'}]}},
  {id:'build',kind:'durable_task',depends_on:['inspect'],operation:{title:'Build'}}
], edges:[{from:'inspect',to:'build',condition:'all_completed'}] };

test('plan IR validates graph and has stable digest', () => {
  assert.equal(validatePlanIr(plan).valid, true);
  assert.equal(computePlanIrDigest(plan), computePlanIrDigest({...plan, nodes:[...plan.nodes]}));
  assert.equal(validatePlanIr({...plan, edges:[...plan.edges,{from:'build',to:'inspect'}]}).valid, false);
});

test('compiler is pure and apply is atomic/idempotent', async () => {
  const proposal = compilePlanIr(plan);
  assert.equal(proposal.nodes.length, 2);
  const state = {};
  const store = { mutate(fn){ return Promise.resolve(fn(state)); } };
  const first = await applyPlanIr(store, { plan, expected_revision:0 });
  const second = await applyPlanIr(store, { plan, expected_revision:1 });
  assert.equal(first.applied, true);
  assert.equal(second.idempotent, true);
  assert.equal(Object.keys(state.workstream_dag.nodes).length, 2);
});

test('node depends_on is validated and compiled into edges', () => {
  const implicit={schema_version:'gptwork.plan_ir.v1',plan_id:'implicit',workstream_id:'ws2',nodes:[
    {id:'a',kind:'durable_task',operation:{}},
    {id:'b',kind:'durable_task',depends_on:['a'],operation:{}}
  ],edges:[]};
  const proposal=compilePlanIr(implicit);
  assert.deepEqual(proposal.edges.map(e=>[e.from,e.to]),[['ws2:plan:a','ws2:plan:b']]);
  assert.equal(validatePlanIr({...implicit,nodes:[implicit.nodes[0],{...implicit.nodes[1],depends_on:['missing']}]}).valid,false);
});
