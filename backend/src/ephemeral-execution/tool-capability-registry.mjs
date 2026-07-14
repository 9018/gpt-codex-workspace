const READ_ONLY=['health_check','runtime_status','worker_status','project_context_status','get_repository_status','read_text_file','stat_path','search_files','sha256_file','github_status','get_workstream_capacity','get_workstream_execution_graph','evaluate_workstream_join'];
const UNKNOWN=Object.freeze({side_effect:'unknown',idempotency:'unknown',execution_class:'durable_only',default_timeout_ms:30000,max_timeout_ms:120000,result_size_limit_bytes:1048576});
export function createToolCapabilityRegistry({descriptors=[]}={}){
  const map=new Map(); let revision=1;
  const api={ register(name,cap={}){ map.set(String(name),{...UNKNOWN,...cap}); revision++; return api; }, get(name){ return map.get(String(name))||UNKNOWN; }, classify(name){ return api.get(name).execution_class; }, get revision(){return revision;} };
  for(const name of READ_ONLY) api.register(name,{side_effect:'none',idempotency:'idempotent',execution_class:'ephemeral_eligible'});
  for(const d of descriptors) api.register(d.name,d.capability||d);
  return api;
}
