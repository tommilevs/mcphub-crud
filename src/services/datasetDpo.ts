import {createHash} from 'node:crypto';
import {assessPreference} from './datasetPreference.js';
import {canonicalDatasetValue as canonical,groupDatasetEvidence,refreshDatasetManifest,type DatasetCall,type DatasetOptions} from './datasetBuilder.js';
export class DpoSelectionTooLarge extends Error{}
export async function buildDpoDataset(db:{query(sql:string,parameters?:any[]):Promise<any[]>},calls:DatasetCall[],options:DatasetOptions){
  const ids=calls.map(call=>call.resultId);
  const pairs=await db.query(`SELECT * FROM dataset_preferences WHERE username=$1 AND key_id IS NOT DISTINCT FROM $2
    AND status='approved' AND privacy_approved=true AND chosen_id=ANY($3::uuid[]) AND rejected_id=ANY($3::uuid[])
    ORDER BY preference_id LIMIT 101`,[options.username,options.keyId,ids]);
  if(pairs.length>100)throw new DpoSelectionTooLarge('Too many preference pairs; reduce the selection');
  const excluded:Record<string,number>={},members:Array<{call:DatasetCall;fingerprint:string}>=[],examples:Array<any>=[];
  const sourceTokens=new Map<string,string[]>(),seen=new Set<string>();let duplicates=0;
  for(const pair of pairs){
    const chosen=calls.find(call=>call.resultId===pair.chosen_id),rejected=calls.find(call=>call.resultId===pair.rejected_id);
    const evidence=assessPreference(chosen,rejected,options);
    if(!evidence||evidence.digest!==pair.evidence_digest){excluded.preference_evidence_changed=(excluded.preference_evidence_changed??0)+1;continue;}
    const fingerprint=createHash('sha256').update(canonical([evidence.contextSha256,evidence.chosenFingerprint,evidence.rejectedFingerprint])).digest('hex');
    members.push({call:chosen!,fingerprint},{call:rejected!,fingerprint});
    sourceTokens.set(fingerprint,[`example:${evidence.chosenFingerprint}`,`example:${evidence.rejectedFingerprint}`]);
    if(seen.has(fingerprint)){duplicates++;continue;}seen.add(fingerprint);
    const action=(call:DatasetCall)=>[{role:'assistant',content:null,tool_calls:[{id:`call_${call.resultId}`,type:'function',function:{name:call.toolName,arguments:call.arguments}}]}];
    const identity=(call:DatasetCall,trust:string)=>({resultId:call.resultId,callId:call.callId??null,taskId:call.taskId,traceId:call.traceId,
      branchId:call.branchId,modelSegmentId:call.segmentId,modelId:call.modelId,source:call.source,trust,rawSha256:call.rawSha256,
      reviewRevision:call.reviewRevision,contextRevision:call.contextRevision,taskRevision:call.taskRevision});
    examples.push({prompt:[{role:'user',content:chosen!.objective}],chosen:action(chosen!),rejected:action(rejected!),
      tools:chosen!.tools.map(tool=>({type:'function',function:{name:tool.name,parameters:tool.inputSchema,...(tool.description!==undefined?{description:tool.description}:{})}})),
      metadata:{version:1,representation:'derived-tool-preference',preferenceId:pair.preference_id,preferenceRevision:pair.revision,
        labelSource:'user_confirmed',contextSource:'reviewed-derived-objective-and-catalogue',originalConversationComplete:false,
        chosenSource:identity(chosen!,evidence.chosenTrust),rejectedSource:identity(rejected!,evidence.rejectedTrust),
        resultIds:[chosen!.resultId,rejected!.resultId],fingerprint,split:''}});
  }
  if(!pairs.length&&calls.length)excluded.approved_preference_missing=calls.length;
  const groups=groupDatasetEvidence(members,options).map(group=>({...group,
    tokens:[...new Set([...group.tokens,...group.fingerprints.flatMap(fp=>sourceTokens.get(fp)??[])])]}));
  for(const example of examples)example.metadata.split=groups.find(group=>group.fingerprints.includes(example.metadata.fingerprint))!.split;
  const dataset={examples,groups,manifest:{version:1,format:'tool-preference-dpo',seed:options.seed??'mcphub-v1',selected:calls.length,
    exported:examples.length,duplicates,excluded,splits:{},contentSha256:''}};
  refreshDatasetManifest(dataset);return dataset;
}
