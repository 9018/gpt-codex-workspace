import { createEphemeralBatchService } from '../ephemeral-execution/ephemeral-batch-service.mjs';
export function createEphemeralExecutionToolsGroup({tool,schema,config={},invokeTool,eventLogger}={}){
 const service=createEphemeralBatchService({config,invokeTool,eventLogger});
 const common={modes:['codex','full'],audience:['chatgpt','codex'],tags:['execution','ephemeral']};
 const properties={calls:{type:'array',items:{type:'object'}},requested_mode:{type:'string'},failure_policy:{type:'string'},max_concurrency:{type:'integer'},requirements:{type:'object'}};
 return {
  classify_execution_intent:tool({name:'classify_execution_intent',description:'Deterministically classify a tool batch as ephemeral or durable. Unknown or side-effecting tools always fall back to durable.',inputSchema:schema(properties,['calls']),...common,handler:async args=>service.classify(args)}),
  run_ephemeral_tool_batch:tool({name:'run_ephemeral_tool_batch',description:'Run an allowlisted read-only tool batch without creating tasks, goals, worktrees, or repo locks. Feature flag guarded.',inputSchema:schema(properties,['calls']),...common,handler:async(args,ctx)=>service.run(args,ctx)}),
 };
}
