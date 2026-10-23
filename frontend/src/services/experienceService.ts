import {apiGet,apiPost,apiPatch} from '@/utils/fetchInterceptor';
import type {ApiResponse} from '@/types';
export interface ExperienceEntry {experience_id:string;title:string;summary:string;task_type:string;scope:{servers?:string[];tools?:string[]};tool_versions:Record<string,string>;
  evidence_ids:string[];status:'draft'|'approved'|'retired';revision:number;reviewed_by:string;reviewed_at:string;
  assessment:{usable:boolean;confidence:string;independentTasks:number;invalidEvidence:number;outcomeSource:string}}
const keyQuery=(keyId:string)=>keyId?`&keyId=${encodeURIComponent(keyId)}`:'';
export const getExperienceAvailability=()=>apiGet<ApiResponse<{enabled:boolean}>>('/experiences/available');
export const listExperiences=(keyId:string,q='')=>apiGet<ApiResponse<ExperienceEntry[]>>(q?
  `/experiences/search?q=${encodeURIComponent(q)}${keyQuery(keyId)}`:`/experiences?limit=50${keyQuery(keyId)}`);
export const readExperience=(id:string,keyId:string)=>apiGet<ApiResponse<ExperienceEntry>>(`/experiences/${encodeURIComponent(id)}?${keyQuery(keyId).slice(1)}`);
export const saveExperience=(value:object)=>apiPost<ApiResponse<unknown>>('/experiences',value);
export const reviewExperience=(id:string,revision:number,status:string,keyId:string)=>apiPatch<ApiResponse<unknown>>(`/experiences/${encodeURIComponent(id)}/status`,{revision,status,keyId:keyId||null});
