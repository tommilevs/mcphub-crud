import {getAppDataSource} from '../db/connection.js';
import {listExperienceEntries} from './experienceMemory.js';
import {mineWorkflowCandidate} from './skillsMiner.js';
import {experienceAppliesTo} from './experienceScope.js';
import {renderSkillDraft} from './skillDraft.js';

export async function previewSkillFromExperience(id:string,username:string,keyId:string|null){
  const entries=await listExperienceEntries({id,username,keyId,status:'approved',limit:1});
  const source=entries[0];
  if(!source?.assessment.usable)return null;
  const rows=await getAppDataSource().query(`SELECT result_id,timestamp,server,tool,attribution
    FROM tool_results WHERE result_id=ANY($1::uuid[]) AND username=$2 AND key_id IS NOT DISTINCT FROM $3`,[source.evidence_ids,username,keyId]);
  if(rows.length!==source.evidence_ids.length||rows.some((row:any)=>!experienceAppliesTo(source.scope,row.server,row.tool)))return null;
  const candidate=mineWorkflowCandidate(rows.map((row:any)=>({resultId:row.result_id,taskId:row.attribution?.taskId??null,
    traceId:row.attribution?.traceId??null,branchId:row.attribution?.branchId??null,timestamp:new Date(row.timestamp),
    server:row.server,tool:row.tool,reviewedPositive:true,modelId:row.attribution?.identity?.modelId??null,
    identitySource:row.attribution?.identity?.source??'unknown'})));
  if(!candidate)return null;
  return {status:'draft',sourceExperienceId:id,sourceExperienceRevision:source.revision,title:source.title,
    applicability:{taskType:source.task_type,scope:source.scope,reportedToolVersions:source.tool_versions},candidate,
    markdown:renderSkillDraft({...candidate,title:source.title,taskType:source.task_type,reportedToolVersions:source.tool_versions})};
}
