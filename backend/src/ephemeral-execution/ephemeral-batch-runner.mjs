import { randomUUID } from 'node:crypto';
import { buildBatchTopology } from './ephemeral-batch-schema.mjs';
function err(e,code='tool_error'){return {code,message:String(e?.message||e),retryable:false};}
async function pool(items,limit,fn){let i=0; const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(i<items.length){const idx=i++; await fn(items[idx]);}}); await Promise.all(workers);}
export async function runEphemeralBatch({batch,invokeTool,maxConcurrency=8,signal}={}){
  const startedAt=new Date(); const topology=buildBatchTopology(batch.calls); const results=new Map(); let failFast=false;
  for(const level of topology.levels){
    await pool(level,Math.min(maxConcurrency,batch.max_concurrency||maxConcurrency),async id=>{
      const call=topology.byId.get(id); const dependencyFailed=(call.depends_on||[]).some(d=>results.get(d)?.status!=='succeeded');
      if(dependencyFailed){results.set(id,{call_id:id,tool_name:call.tool_name,status:'skipped_dependency_failed',output:null,error:{code:'dependency_failed',message:'dependency failed',retryable:false},duration_ms:0});return;}
      if(signal?.aborted||failFast){results.set(id,{call_id:id,tool_name:call.tool_name,status:'cancelled',output:null,error:{code:'cancelled',message:'cancelled',retryable:false},duration_ms:0});return;}
      const start=Date.now(); const controller=new AbortController(); const onAbort=()=>controller.abort(signal?.reason); signal?.addEventListener?.('abort',onAbort,{once:true}); const timer=setTimeout(()=>controller.abort(new Error('timeout')),call.timeout_ms||30000);
      try{const output=await invokeTool(call.tool_name,call.arguments,{signal:controller.signal,call_id:id}); results.set(id,{call_id:id,tool_name:call.tool_name,status:'succeeded',output,error:null,duration_ms:Date.now()-start});}
      catch(e){const timed=controller.signal.aborted&&!signal?.aborted; results.set(id,{call_id:id,tool_name:call.tool_name,status:timed?'timed_out':'failed',output:null,error:err(e,timed?'timeout':'tool_error'),duration_ms:Date.now()-start}); if(batch.failure_policy==='fail_fast') failFast=true;}
      finally{clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);}
    });
  }
  const ordered=batch.calls.map(c=>results.get(c.call_id)); const counts={succeeded:ordered.filter(r=>r.status==='succeeded').length,failed:ordered.filter(r=>['failed','timed_out'].includes(r.status)).length,skipped:ordered.filter(r=>r.status.startsWith('skipped')||r.status==='cancelled').length};
  const status=counts.failed===0&&counts.skipped===0?'succeeded':counts.succeeded>0?'partial':signal?.aborted?'cancelled':'failed';
  return {version:'gptwork.ephemeral_batch_result.v1',batch_id:`eb_${randomUUID()}`,status,started_at:startedAt.toISOString(),completed_at:new Date().toISOString(),results:ordered,summary:counts};
}
