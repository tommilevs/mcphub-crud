import {createHash} from 'node:crypto';
import {groupDatasetEvidence,reviewDatasetCall,refreshDatasetManifest,type DatasetCall,type DatasetOptions} from './datasetBuilder.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Recorded tool events only: not a reconstruction of hidden client/model messages. */
export function buildTrajectoryDataset(calls:DatasetCall[],options:DatasetOptions){
  const excluded:Record<string,number>={},segments=new Map<string,DatasetCall[]>();
  for(const call of calls){
    const key=JSON.stringify([call.taskId,call.traceId,call.branchId,call.segmentId]);
    segments.set(key,[...(segments.get(key)??[]),call]);
  }
  const examples:Array<any>=[],eligible:DatasetCall[]=[];
  for(const [key,segment] of [...segments].sort(([a],[b])=>a.localeCompare(b))){
    const ordered=[...segment].sort((a,b)=>Date.parse(a.timestamp!)-Date.parse(b.timestamp!)||a.resultId.localeCompare(b.resultId));
    const reviews=ordered.map(call=>reviewDatasetCall(call,options,true));
    let reason=reviews.find(review=>review.reason)?.reason;
    if(!ordered[0].branchId||ordered.some(call=>!call.timestamp||!Number.isFinite(Date.parse(call.timestamp))||!['success','error'].includes(call.status??'')))reason??='trajectory_order_or_status_missing';
    if(new Set(ordered.map(call=>call.resultId)).size!==ordered.length||ordered.some(call=>call.retainedSegmentCalls!==ordered.length))reason??='trajectory_segment_incomplete';
    if(new Set(ordered.map(call=>call.modelId)).size!==1)reason??='trajectory_segment_model_conflict';
    if(reason){excluded[reason]=(excluded[reason]??0)+segment.length;continue;}
    eligible.push(...ordered);
    const events=ordered.map((call,index)=>({resultId:call.resultId,callId:call.callId??null,timestamp:call.timestamp,objective:call.objective,
      action:{tool:call.toolName,arguments:JSON.parse(call.arguments!),availableTools:call.tools},
      executionStatus:call.status,quality:call.quality,qualitySource:'user_confirmed',
      result:{resultId:call.resultId,rawSha256:call.rawSha256,representation:'reference'},
      identity:{modelId:call.modelId,source:call.source,trust:reviews[index].trust,verified:call.verified,causalCorrelationVerified:call.causal},
      reviewRevision:call.reviewRevision,contextRevision:call.contextRevision,taskRevision:call.taskRevision}));
    const fingerprint=digest([key,events]);
    examples.push({version:1,events,metadata:{representation:'recorded-tool-trajectory',fingerprint,
      taskId:ordered[0].taskId,traceId:ordered[0].traceId,branchId:ordered[0].branchId,modelSegmentId:ordered[0].segmentId,
      modelId:ordered[0].modelId,identityTrust:reviews.every(review=>review.trust==='trusted')?'trusted':'unverified',
      taskOutcome:ordered[0].outcome,taskOutcomeSource:'user_confirmed',
      coverage:'all-currently-retained-segment-calls',originalConversationComplete:false,
      ordering:'timestamp; equal timestamps do not imply causal order',resultIds:ordered.map(call=>call.resultId),split:''}});
  }
  const grouping=groupDatasetEvidence(eligible.map(call=>({call,fingerprint:reviewDatasetCall(call,options,true).fingerprint})),options);
  const groups=grouping.map(group=>({...group,fingerprints:examples.filter(example=>group.tokens.includes(`trace:${example.metadata.traceId}`)).map(example=>example.metadata.fingerprint)}));
  for(const example of examples)example.metadata.split=groups.find(group=>group.fingerprints.includes(example.metadata.fingerprint))!.split;
  const dataset={examples,groups,manifest:{version:1,format:'recorded-tool-trajectory',seed:options.seed??'mcphub-v1',selected:calls.length,
    exported:examples.length,duplicates:0,excluded,splits:{},contentSha256:''}};
  refreshDatasetManifest(dataset);return dataset;
}
