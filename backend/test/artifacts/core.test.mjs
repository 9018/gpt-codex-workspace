import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactEnvelope } from '../../src/artifacts/artifact-envelope.mjs';
import { createHandoffContractRegistry } from '../../src/artifacts/handoff-contract-registry.mjs';
import { compileAgentInputManifest } from '../../src/artifacts/handoff-compiler.mjs';
import { registerArtifact } from '../../src/artifacts/artifact-store.mjs';

test('artifact envelope is versioned and role-bound', () => {
  const env = createArtifactEnvelope({ artifact_id:'artifact_a', kind:'plan_ir', path:'.gptwork/goals/g/plan.ir.json', sha256:'a'.repeat(64), producer:{role:'planner',agent_run_id:'run1'}, context_digest:'ctx' });
  assert.equal(env.schema_version, 'gptwork.artifact_envelope.v1');
  assert.equal(env.producer.role, 'planner');
});

test('handoff compiler blocks missing, stale, or wrong producer artifacts', () => {
  const registry = createHandoffContractRegistry();
  const contract = registry.get('verifier');
  const available = [
    createArtifactEnvelope({artifact_id:'p',kind:'plan_ir',path:'.gptwork/goals/g/plan.ir.json',sha256:'b'.repeat(64),producer:{role:'planner',agent_run_id:'p1'},context_digest:'ctx'}),
    createArtifactEnvelope({artifact_id:'c',kind:'change_manifest',path:'.gptwork/runs/t/b/change.json',sha256:'c'.repeat(64),producer:{role:'builder',agent_run_id:'b1'},context_digest:'ctx',source_head:'head1'})
  ];
  assert.equal(compileAgentInputManifest({targetRun:{id:'v1',role:'verifier'},contract,availableArtifacts:available,currentContextDigest:'ctx',currentHead:'head1'}).findings.length,0);
  assert.ok(compileAgentInputManifest({targetRun:{id:'v1',role:'verifier'},contract,availableArtifacts:available,currentContextDigest:'stale',currentHead:'head1'}).findings.length>0);
});

test('artifact store is idempotent and stores envelopes only', async () => {
  const state={}; const store={ mutate(fn){return Promise.resolve(fn(state));} };
  const env=createArtifactEnvelope({artifact_id:'a1',kind:'plan_ir',path:'.gptwork/goals/g/plan.json',sha256:'d'.repeat(64),producer:{role:'planner',agent_run_id:'r'},context_digest:'ctx'});
  const a=await registerArtifact(store,env); const b=await registerArtifact(store,env);
  assert.equal(a.artifact.artifact_id,b.artifact.artifact_id);
  assert.equal(state.artifact_index.length,1);
  assert.equal('content' in state.artifact_index[0],false);
});

test('artifact envelope rejects traversal, absolute, and secret paths', () => {
  const base={kind:'plan_ir',sha256:'e'.repeat(64),producer:{role:'planner',agent_run_id:'r'}};
  for (const path of ['../escape.json','/tmp/a.json','.gptwork/.env']) assert.throws(()=>createArtifactEnvelope({...base,path}),/artifact_path/);
});

test('artifact listing isolates task producer scope', async () => {
  const { listArtifacts } = await import('../../src/artifacts/artifact-store.mjs');
  const state={artifact_index:[
    createArtifactEnvelope({artifact_id:'t1',kind:'plan_ir',path:'.gptwork/goals/g1/p.json',sha256:'1'.repeat(64),producer:{role:'planner',agent_run_id:'r1',task_id:'task1'}}),
    createArtifactEnvelope({artifact_id:'t2',kind:'plan_ir',path:'.gptwork/goals/g2/p.json',sha256:'2'.repeat(64),producer:{role:'planner',agent_run_id:'r2',task_id:'task2'}})
  ]};
  const store={load:async()=>state};
  assert.deepEqual((await listArtifacts(store,{task_id:'task1'})).map(a=>a.artifact_id),['t1']);
});
