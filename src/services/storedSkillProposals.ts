import {randomUUID} from 'node:crypto';
import {getAppDataSource} from '../db/connection.js';
import {previewSkillFromExperience} from './skillProposalService.js';

type Owner={username:string;keyId:string|null};
export async function createSkillProposal(experienceId:string,owner:Owner){
  const preview=await previewSkillFromExperience(experienceId,owner.username,owner.keyId);
  if(!preview)return null;
  const rows=await getAppDataSource().query(`WITH saved AS(INSERT INTO skill_proposals
    (proposal_id,username,key_id,source_experience_id,source_revision,source_snapshot,markdown,status,reviewed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$2) RETURNING *)
    INSERT INTO skill_proposal_versions(proposal_id,revision,snapshot)
    SELECT proposal_id,revision,to_jsonb(saved) FROM saved RETURNING snapshot`,
    [randomUUID(),owner.username,owner.keyId,experienceId,preview.sourceExperienceRevision,JSON.stringify(preview),preview.markdown]);
  return rows[0]?.snapshot??null;
}
export async function listSkillProposals(owner:Owner,id?:string){
  return getAppDataSource().query(`SELECT * FROM skill_proposals WHERE username=$1 AND key_id IS NOT DISTINCT FROM $2
    AND ($3::uuid IS NULL OR proposal_id=$3) ORDER BY reviewed_at DESC,proposal_id LIMIT 50`,[owner.username,owner.keyId,id??null]);
}
async function sourceIsCurrent(proposal:any,owner:Owner){
  const current=await previewSkillFromExperience(proposal.source_experience_id,owner.username,owner.keyId);
  return !!current&&current.sourceExperienceRevision===proposal.source_revision&&
    current.candidate.workflowSignature===proposal.source_snapshot.candidate.workflowSignature;
}
/** Every edit revokes approval. An approval always refers to the exact stored revision. */
export async function reviseSkillProposal(id:string,owner:Owner,value:{revision:number;status:'draft'|'approved'|'retired';markdown?:string}){
  const current=(await listSkillProposals(owner,id))[0];
  if(!current||current.revision!==value.revision)return null;
  if(value.status==='approved'&&(value.markdown!==undefined||!await sourceIsCurrent(current,owner)))return null;
  const status=value.markdown!==undefined?'draft':value.status;
  const rows=await getAppDataSource().query(`WITH saved AS(UPDATE skill_proposals SET markdown=$5,status=$6,
    revision=revision+1,reviewed_by=$2,reviewed_at=NOW()
    WHERE proposal_id=$1 AND username=$2 AND key_id IS NOT DISTINCT FROM $3 AND revision=$4 RETURNING *)
    INSERT INTO skill_proposal_versions(proposal_id,revision,snapshot)
    SELECT proposal_id,revision,to_jsonb(saved) FROM saved RETURNING snapshot`,
    [id,owner.username,owner.keyId,value.revision,value.markdown??current.markdown,status]);
  return rows[0]?.snapshot??null;
}
export async function exportSkillProposal(id:string,owner:Owner){
  const current=(await listSkillProposals(owner,id))[0];
  if(!current||current.status!=='approved'||!await sourceIsCurrent(current,owner))return null;
  // A concurrent edit/retirement must not turn an earlier approval into an export authorization.
  const latest=(await listSkillProposals(owner,id))[0];
  return latest?.revision===current.revision&&latest.status==='approved'?current:null;
}
