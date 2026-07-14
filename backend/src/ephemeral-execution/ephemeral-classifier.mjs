export function classifyExecutionIntent(intent,registry,config={}){
  const reasons=[]; const calls=intent.calls.map(c=>({call_id:c.call_id,tool_name:c.tool_name,capability:registry.get(c.tool_name)}));
  if(intent.requested_mode==='durable') reasons.push('requested_durable');
  if(config.enabled!==true) reasons.push('feature_disabled');
  const r=intent.requirements||{};
  if(r.durable_recovery||r.cross_turn_resume||r.human_approval) reasons.push('durability_required');
  if(r.workspace_write||r.external_write||r.repo_write) reasons.push('write_required');
  if(calls.some(c=>c.capability.execution_class!=='ephemeral_eligible'||c.capability.side_effect!=='none')) reasons.push('tool_not_ephemeral_eligible');
  const maxCalls=Number(config.max_calls||32); if(intent.calls.length>maxCalls) reasons.push('too_many_calls');
  const selected_mode=reasons.length?'durable':'ephemeral';
  return {selected_mode,reason_code:reasons[0]||'eligible',reasons,call_classifications:calls,registry_revision:registry.revision};
}
