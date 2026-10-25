import { apiGet, apiPost } from '../utils/fetchInterceptor';
import type { ApiResponse, Group } from '../types';

export interface AcquisitionCandidate {
  name: string;
  displayName: string;
  description: string;
  provenance: { source: 'local_catalog'; repository: string | null };
  installationTypes: string[];
  requiredInputs: string[];
}
export interface AcquisitionPlan {
  plan_id: string;
  manifest_digest: string;
  expires_at: string;
  status: string;
  manifest: {
    serverName: string;
    targetGroup: string;
    package: { name: string; version: string };
    requiredInputs: string[];
    source: { repository: string | null };
  };
}
export interface AcquisitionOperation { operation_id: string; state: string; cancel_requested?: boolean }

export async function findAcquisitionCandidates(objective: string) {
  return apiPost<ApiResponse<{ candidates: AcquisitionCandidate[] }>>('/market/acquisition/proposals', { objective });
}
export async function acquisitionGroups() { return apiGet<ApiResponse<Group[]>>('/groups'); }
export async function prepareAcquisitionPlan(serverName: string, version: string, targetGroup: string) {
  return apiPost<ApiResponse<AcquisitionPlan>>('/market/acquisition/plans', { serverName, version, targetGroup });
}
export async function approveAcquisitionPlan(plan: AcquisitionPlan, idempotencyKey: string) {
  return apiPost<ApiResponse<AcquisitionOperation>>(`/market/acquisition/plans/${encodeURIComponent(plan.plan_id)}/authorize`, {
    digest: plan.manifest_digest, idempotencyKey,
  });
}
export async function getAcquisitionOperation(id: string) {
  return apiGet<ApiResponse<AcquisitionOperation>>(`/market/acquisition/operations/${encodeURIComponent(id)}`);
}
export async function cancelAcquisitionOperation(id: string) {
  return apiPost<ApiResponse<AcquisitionOperation>>(`/market/acquisition/operations/${encodeURIComponent(id)}/cancel`);
}
