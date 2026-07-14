import { createHash } from 'node:crypto';
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>!['generated_at','digest'].includes(k)).map(k=>[k,stable(v[k])]));return v;}
export function computePlanIrDigest(plan){return createHash('sha256').update(JSON.stringify(stable(plan))).digest('hex');}
export function validatePlanIr(plan={}){
  const findings=[]; if(plan.schema_version!=='gptwork.plan_ir.v1') findings.push({code:'invalid_schema_version'}); if(!plan.plan_id) findings.push({code:'missing_plan_id'}); if(!plan.workstream_id) findings.push({code:'missing_workstream_id'});
  const nodes=Array.isArray(plan.nodes)?plan.nodes:[]; const ids=new Set(); for(const n of nodes){if(!n.id||ids.has(n.id)) findings.push({code:'duplicate_or_missing_node',node_id:n.id}); ids.add(n.id); if(!['ephemeral_batch','durable_task','agent_stage','join','integration'].includes(n.kind)) findings.push({code:'invalid_node_kind',node_id:n.id});}
  const explicitEdges=Array.isArray(plan.edges)?plan.edges:[]; const implicitEdges=nodes.flatMap(n=>(n.depends_on||[]).map(from=>({from,to:n.id,condition:'all_completed'}))); const edges=[...explicitEdges,...implicitEdges]; const adj=new Map([...ids].map(id=>[id,[]])); for(const e of edges){if(!ids.has(e.from)||!ids.has(e.to)) findings.push({code:'unknown_edge_node'}); else adj.get(e.from).push(e.to);}
  const visiting=new Set(),done=new Set(); function dfs(id){if(visiting.has(id))return true;if(done.has(id))return false;visiting.add(id);for(const c of adj.get(id)||[])if(dfs(c))return true;visiting.delete(id);done.add(id);return false;} if([...ids].some(dfs)) findings.push({code:'dependency_cycle'});
  return {valid:findings.length===0,findings,digest:findings.length?null:computePlanIrDigest(plan)};
}
