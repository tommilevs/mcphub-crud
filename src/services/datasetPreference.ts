import {createHash,randomUUID} from 'node:crypto';
import {canonicalDatasetValue as canonical,reviewDatasetCall,type DatasetCall,type DatasetOptions} from './datasetBuilder.js';
import {datasetOwnerScope} from './datasetRegistry.js';
import {loadDatasetCalls} from './datasetSource.js';
type Db={query(sql:string,parameters?:any[]):Promise<any[]>};
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const sourceSnapshot=(call:DatasetCall)=>({resultId:call.resultId,rawSha256:call.rawSha256,reviewRevision:call.reviewRevision,
  contextRevision:call.contextRevision,taskRevision:call.taskRevision,modelId:call.modelId,identitySource:call.source});
/** Comparability is explicitly limited to the reviewed derived objective/catalogue, not hidden client state. */
export function assessPreference(chosen:DatasetCall|undefined,rejected:DatasetCall|undefined,options:DatasetOptions){
  if(!chosen||!rejected||chosen.resultId===rejected.resultId||chosen.quality!=='correct'||rejected.quality!=='incorrect')return null;
  const good=reviewDatasetCall(chosen,options),bad=reviewDatasetCall(rejected,options,true);
  if(good.reason||bad.reason)return null;
  const context=(call:DatasetCall)=>({objective:call.objective,tools:call.tools});
  if(canonical(context(chosen))!==canonical(context(rejected)))return null;
  const action=(call:DatasetCall)=>({tool:call.toolName,arguments:JSON.parse(call.arguments!)});
  if(canonical(action(chosen))===canonical(action(rejected)))return null;
  const contextSha256=hash(context(chosen));
  return {digest:hash([contextSha256,action(chosen),action(rejected),sourceSnapshot(chosen),sourceSnapshot(rejected),
      chosen.taskId,chosen.traceId,chosen.segmentId,rejected.taskId,rejected.traceId,rejected.segmentId,
      chosen.verified,chosen.causal,rejected.verified,rejected.causal,chosen.outcome,rejected.outcome]),
    contextSha256,snapshot:{chosen:sourceSnapshot(chosen),rejected:sourceSnapshot(rejected),contextSha256},
    chosenFingerprint:good.fingerprint,rejectedFingerprint:bad.fingerprint,chosenTrust:good.trust,rejectedTrust:bad.trust};
}
export async function createPreference(db:Db,options:DatasetOptions,value:{chosenId:string;rejectedId:string;rationale:string}){
  const calls=await loadDatasetCalls(db,[value.chosenId,value.rejectedId],options.username,options.keyId);
  const evidence=assessPreference(calls.find(call=>call.resultId===value.chosenId),calls.find(call=>call.resultId===value.rejectedId),options);
  if(!evidence)return null;
  const rows=await db.query(`WITH saved AS(INSERT INTO dataset_preferences
    (preference_id,owner_scope,username,key_id,pair_hash,chosen_id,rejected_id,evidence_digest,evidence_snapshot,rationale,allow_self_reported,comparison_hash,status,reviewed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$3) ON CONFLICT DO NOTHING RETURNING *)
    INSERT INTO dataset_preference_versions(preference_id,revision,snapshot)
    SELECT preference_id,revision,to_jsonb(saved) FROM saved RETURNING snapshot`,
    [randomUUID(),datasetOwnerScope(options.username,options.keyId),options.username,options.keyId,
      hash([value.chosenId,value.rejectedId].sort()),value.chosenId,value.rejectedId,evidence.digest,JSON.stringify(evidence.snapshot),
      value.rationale,options.allowSelfReported===true,hash([evidence.chosenFingerprint,evidence.rejectedFingerprint].sort())]);
  return rows[0]?.snapshot??null;
}
export async function listPreferences(db:Db,options:DatasetOptions,id?:string){
  return db.query(`SELECT * FROM dataset_preferences WHERE username=$1 AND key_id IS NOT DISTINCT FROM $2
    AND ($3::uuid IS NULL OR preference_id=$3) ORDER BY reviewed_at DESC,preference_id LIMIT 50`,[options.username,options.keyId,id??null]);
}
export async function reviewPreference(db:Db,options:DatasetOptions,id:string,value:{revision:number;status:string;rationale?:string}){
  const current=(await listPreferences(db,options,id))[0];
  if(!current||current.revision!==value.revision||(current.status==='retired'&&value.status!=='retired'))return null;
  let evidence:any=null;
  if(value.status!=='retired'){
    const calls=await loadDatasetCalls(db,[current.chosen_id,current.rejected_id],options.username,options.keyId);
    evidence=assessPreference(calls.find(call=>call.resultId===current.chosen_id),calls.find(call=>call.resultId===current.rejected_id),
      {...options,allowSelfReported:current.allow_self_reported});
    if(!evidence||(value.status==='approved'&&(value.rationale!==undefined||evidence.digest!==current.evidence_digest)))return null;
  }
  const rows=await db.query(`WITH saved AS(UPDATE dataset_preferences SET status=$5,rationale=$6,privacy_approved=$7,
    evidence_digest=$8,evidence_snapshot=$9,revision=revision+1,reviewed_by=$2,reviewed_at=NOW()
    WHERE preference_id=$1 AND username=$2 AND key_id IS NOT DISTINCT FROM $3 AND revision=$4 RETURNING *)
    INSERT INTO dataset_preference_versions(preference_id,revision,snapshot)
    SELECT preference_id,revision,to_jsonb(saved) FROM saved RETURNING snapshot`,
    [id,options.username,options.keyId,value.revision,value.status,value.rationale??current.rationale,value.status==='approved',
      evidence?.digest??current.evidence_digest,JSON.stringify(evidence?.snapshot??current.evidence_snapshot)]);
  return rows[0]?.snapshot??null;
}
