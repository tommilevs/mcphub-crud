import {createHash} from 'node:crypto';
export interface WorkflowObservation {
  resultId:string;taskId:string|null;traceId:string|null;branchId:string|null;timestamp:Date;
  server:string;tool:string;reviewedPositive:boolean;modelId:string|null;identitySource:string;
}
/** Temporal patterns are proposals, never proof of causality or permission to execute. */
export function mineWorkflowCandidate(calls:WorkflowObservation[]){
  if(calls.length<4||calls.length>200||new Set(calls.map(call=>call.resultId)).size!==calls.length)return null;
  const groups=new Map<string,WorkflowObservation[]>();
  for(const call of calls){
    if(!call.reviewedPositive||!call.taskId||!call.traceId||!call.branchId||!call.server||!call.tool||!Number.isFinite(call.timestamp.getTime()))return null;
    const group=groups.get(call.taskId)??[];group.push(call);groups.set(call.taskId,group);
  }
  if(groups.size<2)return null;
  let signature:string|undefined,steps:Array<{server:string;tool:string}>|undefined;
  const ordered:WorkflowObservation[]=[];
  for(const [,group] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
    if(group.length<2||new Set(group.map(call=>JSON.stringify([call.traceId,call.branchId]))).size!==1)return null;
    group.sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime());
    if(group.some((call,index)=>index>0&&call.timestamp.getTime()<=group[index-1].timestamp.getTime()))return null;
    const sequence=group.map(call=>({server:call.server,tool:call.tool})),current=JSON.stringify(sequence);
    if(signature!==undefined&&signature!==current)return null;
    signature=current;steps=sequence;ordered.push(...group);
  }
  const observations=new Map<string,{modelId:string|null;source:string}>();
  for(const call of ordered){const model={modelId:call.modelId,source:call.modelId?call.identitySource:'unknown'};observations.set(JSON.stringify(model),model);}
  return {steps:steps!,independentTasks:groups.size,evidenceResultIds:ordered.map(call=>call.resultId),
    taskIds:[...groups.keys()].sort(),modelObservations:[...observations.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    sequenceEvidence:'temporal' as const,outcomeSource:'user_confirmed' as const,confidence:'proposal' as const,
    workflowSignature:createHash('sha256').update(signature!).digest('hex')};
}
