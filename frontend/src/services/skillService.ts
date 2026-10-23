import type {ApiResponse} from '@/types';
import {apiGet,apiPost,apiPatch,fetchWithInterceptors} from '@/utils/fetchInterceptor';
import {getApiUrl} from '@/utils/runtime';
export interface SkillProposal {proposal_id:string;source_experience_id:string;source_revision:number;revision:number;
  status:'draft'|'approved'|'retired';markdown:string;reviewed_by:string;reviewed_at:string}
export const listSkills=(keyId:string)=>apiGet<ApiResponse<SkillProposal[]>>(`/skills${keyId?`?keyId=${encodeURIComponent(keyId)}`:''}`);
export interface SkillVersion {revision:number;markdown:string;status:string;reviewedBy:string;reviewedAt:string;sourceExperienceRevision:number}
export const readSkillVersions=(id:string,keyId:string,beforeRevision?:number)=>apiGet<ApiResponse<{versions:SkillVersion[];nextBeforeRevision:number|null}>>(
  `/skills/${encodeURIComponent(id)}/versions?${new URLSearchParams({...keyId?{keyId}:{},...beforeRevision?{beforeRevision:String(beforeRevision)}:{}})}`);
export const createSkill=(experienceId:string,keyId:string)=>apiPost<ApiResponse<SkillProposal>>('/skills',{experienceId,keyId:keyId||null});
export const reviseSkill=(id:string,value:{revision:number;status:string;markdown?:string},keyId:string)=>
  apiPatch<ApiResponse<SkillProposal>>(`/skills/${encodeURIComponent(id)}`,{...value,keyId:keyId||null});
export async function downloadSkill(id:string,keyId:string):Promise<Blob>{
  const response=await fetchWithInterceptors(getApiUrl(`/skills/${encodeURIComponent(id)}/export`),{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyId:keyId||null})});
  if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error?.message||`HTTP ${response.status}`);}
  return response.blob();
}
