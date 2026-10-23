import type {ApiResponse} from '@/types';
import {apiGet,apiPost,fetchWithInterceptors} from '@/utils/fetchInterceptor';
import {getApiUrl} from '@/utils/runtime';
export interface DatasetSelection {resultIds:string[];keyId:string|null;allowSelfReported:boolean;seed:string}
export interface DatasetManifest {version:number;format:string;seed:string;selected:number;exported:number;duplicates:number;
  excluded:Record<string,number>;splits:Record<string,number>;contentSha256:string}
export const getDatasetAvailability=()=>apiGet<ApiResponse<{enabled:boolean}>>('/datasets/available');
export const previewDataset=(value:DatasetSelection)=>apiPost<ApiResponse<DatasetManifest>>('/datasets/preview',value);
export interface DatasetExportRecord {export_id:string;split:string;selected_ids:string[];exported_ids:string[];manifest:DatasetManifest;
  file_sha256:string;byte_length:number;created_at:string}
export const listDatasetExports=(keyId:string)=>apiGet<ApiResponse<DatasetExportRecord[]>>(`/datasets/exports${keyId?`?keyId=${encodeURIComponent(keyId)}`:''}`);
export async function downloadDataset(value:DatasetSelection,split:string):Promise<Blob>{
  const response=await fetchWithInterceptors(getApiUrl('/datasets/export'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,split})});
  if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error?.message||`HTTP ${response.status}`);}
  return response.blob();
}
