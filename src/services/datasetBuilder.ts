import { createHash } from 'node:crypto';

export interface DatasetCall {
  resultId:string;username:string|null;keyId:string|null;taskId:string|null;traceId:string|null;branchId:string|null;segmentId:string|null;
  modelId:string|null;source:string;verified:boolean;causal:boolean;conflict:boolean;payloadAvailable:boolean;
  rawSha256:string|null;objective:string|null;toolName:string|null;arguments:string|null;tools:Array<{name:string;inputSchema:object;description?:string}>;
  consent:boolean;outcome:string;quality:string;privacy:boolean;contextPrivacy:boolean;reviewDigest:string|null;
  reviewRevision:number;contextRevision:number;taskRevision:number;
  timestamp?:string;status?:string;retainedSegmentCalls?:number;callId?:string|null;
}
export interface DatasetOptions { username:string;keyId:string|null;allowSelfReported?:boolean;seed?:string }
const canonical=(value:any):string=>JSON.stringify(value&&typeof value==='object'?
  Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sensitive=(value:unknown,key=''):boolean=>{
  if(typeof value==='string')return (/(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization|trace[_-]?key)/i.test(key)&&
    Boolean(value)&&value!=='[REDACTED]')||/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|k_[A-Za-z0-9_-]{32})\b/.test(value)||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);
  if(Array.isArray(value))return value.some(item=>sensitive(item));
  if(value&&typeof value==='object')return Object.entries(value).some(([name,item])=>sensitive(item,name));
  return false;
};

export function reviewDatasetCall(call:DatasetCall,options:DatasetOptions,trajectory=false){
  const trusted=call.verified&&call.causal&&['host_reported','gateway_observed'].includes(call.source);
  const self=options.allowSelfReported===true&&call.source==='self_reported'&&!call.verified;
  let reason:string|undefined;
  if(call.username!==options.username||call.keyId!==options.keyId)reason='tenant_mismatch';
  else if(call.conflict)reason='attribution_conflicted';
  else if(!call.modelId||(!trusted&&!self))reason='untrusted_model_attribution';
  else if(!call.taskId||!call.traceId||!call.segmentId)reason='trace_context_missing';
  else if(!call.payloadAvailable||!call.rawSha256)reason='payload_unavailable';
  else if(!call.consent)reason='training_consent_missing';
  else if(!(trajectory?['success','partial','failure']:['success','partial']).includes(call.outcome))reason='positive_task_outcome_missing';
  else if(!(trajectory?['correct','incorrect']:['correct']).includes(call.quality))reason='call_quality_not_positive';
  else if(!call.privacy||call.reviewDigest!==call.rawSha256)reason='redaction_review_missing';
  else if(!call.contextPrivacy||!call.objective||!call.toolName||!Array.isArray(call.tools)||!call.tools.length||!call.tools.some(tool=>tool.name===call.toolName))reason='discovery_context_missing';
  let args:unknown;
  try{args=JSON.parse(call.arguments??'null');if(!args||typeof args!=='object'||Array.isArray(args))reason??='invalid_arguments';}
  catch{reason??='invalid_arguments';}
  if(!reason&&sensitive({objective:call.objective,tools:call.tools,arguments:args,modelId:call.modelId}))reason='sensitive_data_detected';
  return {reason,trust:trusted?'trusted' as const:'unverified' as const,
    fingerprint:reason?'':hash(canonical({objective:call.objective,tools:call.tools,tool:call.toolName,arguments:args}))};
}

/** Pure linkage/split calculation shared by SFT and recorded trajectories; no outcome relabeling. */
export function groupDatasetEvidence(members:Array<{call:DatasetCall;fingerprint:string}>,options:DatasetOptions){
  const parent=members.map((_,index)=>index);
  const root=(i:number):number=>parent[i]===i?i:(parent[i]=root(parent[i]));
  const seen=new Map<string,number>();
  members.forEach(({call,fingerprint},index)=>{
    for(const token of [`task:${call.taskId}`,`trace:${call.traceId}`,`example:${fingerprint}`]){
      const previous=seen.get(token);
      if(previous===undefined)seen.set(token,index);else parent[root(index)]=root(previous);
    }
  });
  const components=new Map<number,Array<{call:DatasetCall;fingerprint:string}>>();
  members.forEach((member,index)=>{const group=root(index);components.set(group,[...(components.get(group)??[]),member]);});
  return [...components.values()].map(group=>{
    const identities=[...new Set(group.flatMap(({call})=>[`task:${call.taskId}`,`trace:${call.traceId}`]))].sort();
    const bucket=parseInt(hash(canonical([options.username,options.keyId,options.seed??'mcphub-v1',identities])).slice(0,8),16)%100;
    return {tokens:[...new Set(group.flatMap(({call,fingerprint})=>[`task:${call.taskId}`,`trace:${call.traceId}`,`example:${fingerprint}`]))],
      fingerprints:[...new Set(group.map(member=>member.fingerprint))],split:bucket<80?'train':bucket<90?'validation':'test'};
  });
}

/** Positive tool-selection SFT only. No fabricated final responses or preference labels. */
export function buildDataset(calls:DatasetCall[],options:DatasetOptions){
  const excluded:Record<string,number>={};
  const reject=(reason:string)=>{excluded[reason]=(excluded[reason]??0)+1;};
  const accepted:Array<{call:DatasetCall;fingerprint:string;trust:'trusted'|'unverified'}>=[];
  for(const call of [...calls].sort((a,b)=>a.resultId.localeCompare(b.resultId))){
    const {reason,trust,fingerprint}=reviewDatasetCall(call,options);
    if(reason){reject(reason);continue;}
    accepted.push({call,trust,fingerprint});
  }
  // Connected components prevent leakage through shared tasks, traces or duplicate prompts.
  const groups=groupDatasetEvidence(accepted,options);
  const splits=new Map(groups.flatMap(group=>group.fingerprints.map(fp=>[fp,group.split] as [string,string])));
  const fingerprints=new Set<string>();
  let duplicates=0;
  const examples=accepted.flatMap(({call,fingerprint,trust})=>{
    if(fingerprints.has(fingerprint)){duplicates++;return [];}
    fingerprints.add(fingerprint);
    const split=splits.get(fingerprint)!;
    return [{messages:[{role:'user',content:call.objective},{role:'assistant',content:null,tool_calls:[{id:`call_${call.resultId}`,type:'function',
      function:{name:call.toolName,arguments:call.arguments}}]}],tools:call.tools.map(tool=>({type:'function',function:{name:tool.name,parameters:tool.inputSchema,...(tool.description!==undefined?{description:tool.description}:{})}})),
      metadata:{version:1,resultId:call.resultId,taskId:call.taskId,traceId:call.traceId,branchId:call.branchId,modelSegmentId:call.segmentId,
        modelId:call.modelId,identityTrust:trust,identitySource:call.source,qualitySource:'user_confirmed',taskOutcome:call.outcome,
        rawSha256:call.rawSha256,reviewRevision:call.reviewRevision,contextRevision:call.contextRevision,taskRevision:call.taskRevision,
        split,fingerprint,representation:'derived-direct-tool-selection'}}];
  });
  return {examples,groups,manifest:{version:1,format:'tool-selection-sft',seed:options.seed??'mcphub-v1',selected:calls.length,
    exported:examples.length,duplicates,excluded,splits:Object.fromEntries(['train','validation','test'].map(split=>[split,examples.filter(row=>row.metadata.split===split).length])),
    contentSha256:hash(canonical(examples))}};
}

export interface DatasetArtifact {
  examples:Array<{metadata:{split:string;fingerprint:string;resultId?:string;resultIds?:string[]};[key:string]:unknown}>;
  groups:Array<{tokens:string[];fingerprints:string[];split:string}>;
  manifest:{version:number;format:string;seed:string;selected:number;exported:number;duplicates:number;excluded:Record<string,number>;splits:Record<string,number>;contentSha256:string};
}
export function refreshDatasetManifest(dataset:DatasetArtifact):void{
  dataset.manifest.splits=Object.fromEntries(['train','validation','test'].map(split=>[split,dataset.examples.filter(row=>row.metadata.split===split).length]));
  dataset.manifest.contentSha256=hash(canonical(dataset.examples));
}
