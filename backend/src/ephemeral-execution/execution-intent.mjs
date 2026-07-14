import { randomUUID } from 'node:crypto';
export const EXECUTION_INTENT_VERSION='gptwork.execution_intent.v1';
export function normalizeFailurePolicy(v){ return ['collect_errors','fail_fast','best_effort'].includes(v)?v:'collect_errors'; }
export function createExecutionIntent(input={}){
  const calls=(input.calls||[]).map((c,i)=>({call_id:String(c.call_id||`call_${i}`),tool_name:String(c.tool_name||''),arguments:c.arguments&&typeof c.arguments==='object'?c.arguments:{},depends_on:[...(c.depends_on||[])].map(String),timeout_ms:Number(c.timeout_ms||30000)}));
  if(calls.length>32) throw new Error('batch_too_large');
  const ids=new Set(); for(const c of calls){ if(!c.call_id||!c.tool_name) throw new Error('invalid_call'); if(ids.has(c.call_id)) throw new Error('duplicate_call_id'); ids.add(c.call_id); }
  for(const c of calls){ for(const d of c.depends_on){ if(d===c.call_id) throw new Error('self_dependency'); if(!ids.has(d)) throw new Error('unknown_dependency'); } }
  return {version:EXECUTION_INTENT_VERSION,intent_id:input.intent_id||`intent_${randomUUID()}`,requested_mode:['auto','ephemeral','durable'].includes(input.requested_mode)?input.requested_mode:'auto',operation_kind:input.operation_kind||'tool_batch',calls,requirements:{durable_recovery:false,cross_turn_resume:false,workspace_write:false,external_write:false,human_approval:false,...(input.requirements||{})},failure_policy:normalizeFailurePolicy(input.failure_policy),max_concurrency:Math.max(1,Math.min(32,Number(input.max_concurrency||8))),created_at:input.created_at||new Date().toISOString()};
}
