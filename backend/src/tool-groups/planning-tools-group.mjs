import { validatePlanIr } from '../planning/plan-ir-schema.mjs';
import { compilePlanIr } from '../planning/plan-ir-compiler.mjs';
import { applyPlanIr } from '../planning/plan-ir-applier.mjs';
export function createPlanningToolsGroup({tool,schema,store,config={}}={}){const common={modes:['codex','full'],audience:['chatgpt','codex'],tags:['planning','dag']}; const enabled=()=>{if(config.planIrEnabled!==true) throw new Error('plan_ir_disabled');}; return {
 validate_plan_ir:tool({name:'validate_plan_ir',description:'Validate and digest a versioned Planner DAG IR without mutating state.',inputSchema:schema({plan:{type:'object'}},['plan']),...common,handler:async({plan})=>{enabled();return validatePlanIr(plan)}}),
 compile_plan_ir:tool({name:'compile_plan_ir',description:'Compile a valid Planner DAG IR into a deterministic mutation proposal without mutating state.',inputSchema:schema({plan:{type:'object'}},['plan']),...common,handler:async({plan})=>{if(config.planIrEnabled!==true)throw new Error('plan_ir_disabled');return compilePlanIr(plan);}}),
 apply_plan_ir:tool({name:'apply_plan_ir',description:'Atomically and idempotently apply a Planner DAG IR to durable workstream DAG state with revision checking.',inputSchema:schema({plan:{type:'object'},expected_revision:{type:'integer'}},['plan']),...common,handler:async({plan,expected_revision})=>{if(config.planIrEnabled!==true)throw new Error('plan_ir_disabled');return applyPlanIr(store,{plan,expected_revision:Number(expected_revision||0)});}})
};}
