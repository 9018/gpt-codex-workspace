export function buildBatchTopology(calls=[]){
  const byId=new Map(calls.map(c=>[c.call_id,c])); const indegree=new Map(calls.map(c=>[c.call_id,(c.depends_on||[]).length])); const children=new Map(calls.map(c=>[c.call_id,[]]));
  for(const c of calls) for(const d of c.depends_on||[]) children.get(d)?.push(c.call_id);
  let frontier=calls.filter(c=>indegree.get(c.call_id)===0).map(c=>c.call_id); const levels=[]; const order=[];
  while(frontier.length){ const level=[...frontier]; levels.push(level); frontier=[]; for(const id of level){ order.push(id); for(const child of children.get(id)||[]){ indegree.set(child,indegree.get(child)-1); if(indegree.get(child)===0) frontier.push(child); } } }
  if(order.length!==calls.length) throw new Error('dependency_cycle');
  return {order,levels,byId};
}
