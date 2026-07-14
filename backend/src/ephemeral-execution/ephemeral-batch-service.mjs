import { createExecutionIntent } from './execution-intent.mjs';
import { createToolCapabilityRegistry } from './tool-capability-registry.mjs';
import { classifyExecutionIntent } from './ephemeral-classifier.mjs';
import { runEphemeralBatch } from './ephemeral-batch-runner.mjs';
export function createEphemeralBatchService({config={},invokeTool,eventLogger}={}){
 const registry=createToolCapabilityRegistry();
 const classify=(input)=>{const intent=createExecutionIntent(input);return {intent,classification:classifyExecutionIntent(intent,registry,{enabled:config.ephemeralBatchEnabled===true,max_calls:config.ephemeralBatchMaxCalls||32})};};
 return {
  registry,
  classify,
  async run(input,context={}){const {intent,classification}=classify(input);if(classification.selected_mode!=='ephemeral')return {executed:false,...classification,intent};const result=await runEphemeralBatch({batch:intent,invokeTool,maxConcurrency:config.ephemeralBatchConcurrency||8,signal:context.signal});await eventLogger?.append?.('ephemeral_batch.completed',{batch_id:result.batch_id,status:result.status,summary:result.summary,tool_names:intent.calls.map(c=>c.tool_name)});return {...result,executed:true,classification};}
 };
}
