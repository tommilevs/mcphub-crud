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
    probe?: { tool: string };
  };
}
export interface AcquisitionOperation { operation_id: string; state: string; cancel_requested?: boolean; requires_reconciliation?: boolean; failure_code?: string | null;
  verification?: 'discovery_only' | 'functional' | 'functional_failed' | null; plan_id?: string;
  execution_started?: boolean; execution_stale?: boolean; publication_started?: boolean; publication_applied_at?: string | null }

export const acquisitionTerminal = (operation: AcquisitionOperation) => ['ready', 'failed', 'rolled_back', 'cancelled'].includes(operation.state);
export function acquisitionOperationStatus(operation: AcquisitionOperation) {
  if (operation.requires_reconciliation) return { key: 'uncertain', text: 'Installation needs review. It will not restart automatically.' };
  if (operation.execution_stale) return { key: 'stale', text: 'No recent worker activity. Refresh status or mark this installation for review.' };
  if (operation.cancel_requested && !acquisitionTerminal(operation)) return { key: 'cancelling', text: 'Cancellation requested. Waiting for the current step to stop.' };
  if (operation.state === 'authorized') return operation.execution_started
    ? { key: 'queued', text: 'Queued or preparing required configuration.' }
    : { key: 'authorized', text: 'Authorization saved. Enter required values, then choose Start installation.' };
  if (operation.state === 'staging') return { key: 'installing', text: 'Installing the pinned package.' };
  if (operation.state === 'starting') return { key: 'checking', text: 'Package installed. Checking the MCP server.' };
  if (operation.state === 'verifying') return operation.publication_applied_at
    ? { key: 'activating', text: 'Starting the server and updating the tool index.' }
    : { key: 'verifying', text: 'Checking available tools and saving server configuration.' };
  if (operation.state === 'ready') return { key: 'ready', text: 'Server is ready in the selected group.' };
  if (operation.state === 'rolled_back') return { key: 'rolledBack', text: 'Server registration was rolled back.' };
  if (operation.state === 'cancelled') return { key: 'cancelled', text: 'Installation cancelled before execution.' };
  return { key: 'failed', text: 'Installation stopped. Review its status before trying again.' };
}

export async function findAcquisitionCandidates(objective: string) {
  return apiPost<ApiResponse<{ candidates: AcquisitionCandidate[] }>>('/market/acquisition/proposals', { objective });
}
export async function acquisitionGroups() { return apiGet<ApiResponse<Group[]>>('/groups'); }
export async function prepareAcquisitionPlan(serverName: string, version: string, targetGroup: string, probeTool?: string) {
  return apiPost<ApiResponse<AcquisitionPlan>>('/market/acquisition/plans', { serverName, version, targetGroup, ...(probeTool ? { probeTool } : {}) });
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
export async function executeAcquisitionOperation(id: string, credentials: Record<string, string>) {
  return apiPost<ApiResponse<{ operationId: string; status: 'accepted' }>>(`/market/acquisition/operations/${encodeURIComponent(id)}/execute`, { credentials });
}
export async function getAcquisitionPlan(id: string) {
  return apiGet<ApiResponse<AcquisitionPlan>>(`/market/acquisition/plans/${encodeURIComponent(id)}`);
}
export async function reviewInterruptedAcquisition(id: string) {
  return apiPost<ApiResponse<AcquisitionOperation>>(`/market/acquisition/operations/${encodeURIComponent(id)}/review-interrupted`, {});
}
