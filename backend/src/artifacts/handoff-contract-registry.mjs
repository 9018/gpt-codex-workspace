const CONTRACTS={
 context_curator:{requires:[],produces:['context_manifest']},
 planner:{requires:['context_manifest'],produces:['plan_ir']},
 builder:{requires:['context_manifest','plan_ir'],produces:['change_manifest']},
 verifier:{requires:['plan_ir','change_manifest'],produces:['verification_report'],fresh_head:['change_manifest']},
 repairer:{requires:['verification_report','change_manifest'],produces:['repair_report','change_manifest']},
 reviewer:{requires:['plan_ir','change_manifest','verification_report'],produces:['review_decision']},
 integrator:{requires:['change_manifest','review_decision'],produces:['integration_report']},
 finalizer:{requires:['review_decision','verification_report'],produces:['final_result']}
};
export function createHandoffContractRegistry(){return {get(role){const c=CONTRACTS[role];if(!c)throw new Error('unknown_handoff_role');return {pipeline_version:'task_pipeline_v3',role,requires:c.requires.map(kind=>({kind,min:1,max:kind==='change_manifest'&&role==='integrator'?99:1})),produces:c.produces.map(kind=>({kind,min:1,max:1})),fresh_head:c.fresh_head||[],forbidden_inputs:['full_transcript']};},roles(){return Object.keys(CONTRACTS);}};}
