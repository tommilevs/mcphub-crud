import type {ApiResponse} from '@/types';
import {apiGet,apiPost,apiPatch} from '@/utils/fetchInterceptor';
export interface DatasetPreference {preference_id:string;chosen_id:string;rejected_id:string;rationale:string;status:string;revision:number;
  evidence_digest:string;privacy_approved:boolean;reviewed_by:string;reviewed_at:string}
export const preferenceAvailability=()=>apiGet<ApiResponse<{enabled:boolean}>>('/datasets/preferences/available');
export const listPreferences=(keyId:string)=>apiGet<ApiResponse<DatasetPreference[]>>(`/datasets/preferences${keyId?`?keyId=${encodeURIComponent(keyId)}`:''}`);
export const createPreference=(value:object)=>apiPost<ApiResponse<DatasetPreference>>('/datasets/preferences',value);
export const reviewPreference=(id:string,value:object)=>apiPatch<ApiResponse<DatasetPreference>>(`/datasets/preferences/${encodeURIComponent(id)}`,value);
