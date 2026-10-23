import {randomUUID} from 'node:crypto';
import {getAppDataSource} from '../db/connection.js';
import {assessExperienceEvidence,type ExperienceEvidence} from './experienceEvidence.js';

export async function loadExperienceEvidence(ids:string[],username:string,keyId:string|null):Promise<ExperienceEvidence[]>{
  const rows=await getAppDataSource().query(`SELECT result.result_id,result.attribution->>'taskId' AS task_id,
    result.payload_available,result.raw_sha256,review.raw_sha256 AS review_digest,review.quality,review.privacy,task.outcome
    FROM tool_results result
    LEFT JOIN LATERAL(SELECT * FROM tool_result_reviews WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1) review ON TRUE
    LEFT JOIN LATERAL(SELECT * FROM attribution_task_reviews WHERE task_id::text=result.attribution->>'taskId' ORDER BY revision DESC LIMIT 1) task ON TRUE
    WHERE result.result_id=ANY($1::uuid[]) AND result.username=$2 AND result.key_id IS NOT DISTINCT FROM $3`,[ids,username,keyId]);
  return rows.map((row:any)=>({resultId:row.result_id,taskId:row.task_id,payloadAvailable:row.payload_available===true,
    rawSha256:row.raw_sha256,reviewDigest:row.review_digest,quality:row.quality,privacy:row.privacy,outcome:row.outcome}));
}
export async function createExperience(value:{username:string;keyId:string|null;title:string;summary:string;taskType:string;
  scope:object;toolVersions:object;evidenceIds:string[];approved:boolean}){
  const evidence=await loadExperienceEvidence(value.evidenceIds,value.username,value.keyId);
  if(evidence.length!==value.evidenceIds.length)return null;
  const assessment=assessExperienceEvidence(value.evidenceIds,evidence);
  if(value.approved&&!assessment.usable)return null;
  const id=randomUUID();
  const rows=await getAppDataSource().query(`WITH created AS(INSERT INTO experience_entries
    (experience_id,username,key_id,title,summary,task_type,scope,tool_versions,evidence_ids,evidence_snapshot,status,reviewed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$2) RETURNING *)
    INSERT INTO experience_entry_audit(experience_id,revision,snapshot)
    SELECT experience_id,revision,to_jsonb(created)-'search_vector' FROM created RETURNING experience_id,revision`,
  [id,value.username,value.keyId,value.title,value.summary,value.taskType,JSON.stringify(value.scope),JSON.stringify(value.toolVersions),
    value.evidenceIds,JSON.stringify(evidence),value.approved?'approved':'draft']);
  return {...rows[0],assessment};
}
export async function searchExperiences(value:{username:string;keyId:string|null;query:string;taskType?:string;limit:number}){
  const entries=await getAppDataSource().query(`SELECT experience_id,title,summary,task_type,scope,tool_versions,
    evidence_ids,revision,reviewed_by,reviewed_at FROM experience_entries
    WHERE username=$1 AND key_id IS NOT DISTINCT FROM $2 AND status='approved'
      AND ($3='' OR search_vector @@ websearch_to_tsquery('simple',$3)) AND ($4::text IS NULL OR task_type=$4)
    ORDER BY ts_rank(search_vector,websearch_to_tsquery('simple',$3)) DESC,reviewed_at DESC,experience_id LIMIT 100`,
  [value.username,value.keyId,value.query,value.taskType??null]);
  const ids=[...new Set<string>(entries.flatMap((entry:any)=>entry.evidence_ids))];
  const evidence=ids.length?await loadExperienceEvidence(ids,value.username,value.keyId):[];
  return entries.map((entry:any)=>({...entry,assessment:assessExperienceEvidence(entry.evidence_ids,evidence)}))
    .filter((entry:any)=>entry.assessment.usable).slice(0,value.limit);
}
