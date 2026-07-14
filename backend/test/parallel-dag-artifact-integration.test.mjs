import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeralExecutionToolsGroup } from '../src/tool-groups/ephemeral-execution-tools-group.mjs';
import { createPlanningToolsGroup } from '../src/tool-groups/planning-tools-group.mjs';
import { createArtifactHandoffToolsGroup } from '../src/tool-groups/artifact-handoff-tools-group.mjs';
import { validateAgentArtifactContract } from '../src/agent-artifact-contract.mjs';
const tool=(d)=>d; const schema=(p,r=[])=>({properties:p,required:r});

test('ephemeral tool group classifies and executes allowlisted calls without state mutation', async()=>{
 const state={tasks:[],goals:[]}; const store={load:async()=>state,mutate:async fn=>fn(state)};
 const group=createEphemeralExecutionToolsGroup({tool,schema,store,config:{ephemeralBatchEnabled:true,ephemeralBatchConcurrency:2},invokeTool:async(name)=>({name})});
 const before=JSON.stringify(state);
 const out=await group.run_ephemeral_tool_batch.handler({calls:[{call_id:'h',tool_name:'health_check'}]});
 assert.equal(out.status,'succeeded'); assert.equal(JSON.stringify(state),before);
});

test('planning tools validate and atomically apply IR', async()=>{
 const state={}; const store={load:async()=>state,mutate:async fn=>fn(state)}; const group=createPlanningToolsGroup({tool,schema,store,config:{planIrEnabled:true}});
 const plan={schema_version:'gptwork.plan_ir.v1',plan_id:'p',workstream_id:'ws',nodes:[{id:'a',kind:'durable_task',operation:{}}],edges:[]};
 assert.equal((await group.validate_plan_ir.handler({plan})).valid,true);
 assert.equal((await group.apply_plan_ir.handler({plan,expected_revision:0})).applied,true);
});

test('artifact handoff tools register envelope and compile runnable verifier manifest', async()=>{
 const state={}; const store={load:async()=>state,mutate:async fn=>fn(state)}; const group=createArtifactHandoffToolsGroup({tool,schema,store,config:{artifactHandoffV3Enabled:true}});
 for(const envelope of [
  {artifact_id:'p',kind:'plan_ir',path:'.gptwork/goals/g/p.json',sha256:'a'.repeat(64),producer:{role:'planner',agent_run_id:'pr'},context_digest:'ctx'},
  {artifact_id:'c',kind:'change_manifest',path:'.gptwork/runs/t/b/c.json',sha256:'b'.repeat(64),producer:{role:'builder',agent_run_id:'br'},context_digest:'ctx',source_head:'head'}]) await group.register_agent_artifact.handler({envelope});
 const out=await group.prepare_agent_handoff.handler({agent_run_id:'vr',role:'verifier',context_digest:'ctx',source_head:'head'});
 assert.equal(out.runnable,true);
});

test('pipeline v3 artifact contract requires typed kinds',()=>{
 const run={role:'planner',pipeline_version:'task_pipeline_v3',status:'completed',output_artifacts:[{kind:'plan_ir',path:'x',metadata:{context_digest:'ctx'}}],input_context_digest:'ctx'};
 assert.equal(validateAgentArtifactContract(run).valid,true);
 assert.equal(validateAgentArtifactContract({...run,output_artifacts:[{kind:'plan',path:'x'}]}).valid,false);
});


test('disabled Plan IR and artifact v3 handlers fail closed', async()=>{
 const state={}; const store={load:async()=>state,mutate:async fn=>fn(state)};
 const planGroup=createPlanningToolsGroup({tool,schema,store,config:{planIrEnabled:false}});
 await assert.rejects(()=>planGroup.validate_plan_ir.handler({plan:{}}),/plan_ir_disabled/);
 const artifactGroup=createArtifactHandoffToolsGroup({tool,schema,store,config:{artifactHandoffV3Enabled:false}});
 await assert.rejects(()=>artifactGroup.register_agent_artifact.handler({envelope:{}}),/artifact_handoff_v3_disabled/);
});

test('prepare handoff only consumes artifacts from the requested task', async()=>{
 const state={}; const store={load:async()=>state,mutate:async fn=>fn(state)}; const group=createArtifactHandoffToolsGroup({tool,schema,store,config:{artifactHandoffV3Enabled:true}});
 const base=(id,kind,role,task)=>({artifact_id:id,kind,path:`.gptwork/${id}.json`,sha256:id[0].repeat(64),producer:{role,agent_run_id:`run_${id}`,task_id:task},context_digest:'ctx',source_head:'head'});
 for(const env of [base('aaaa','plan_ir','planner','t1'),base('bbbb','change_manifest','builder','t2')]) await group.register_agent_artifact.handler({envelope:env});
 const out=await group.prepare_agent_handoff.handler({agent_run_id:'v',role:'verifier',task_id:'t1',context_digest:'ctx',source_head:'head'});
 assert.equal(out.runnable,false);
 assert.ok(out.findings.some(f=>f.kind==='change_manifest'));
});
