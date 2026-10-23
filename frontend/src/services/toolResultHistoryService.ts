import type {
  ApiResponse,
  PaginationInfo,
  ToolResultDetail,
  ToolResultFilter,
  ToolResultStats,
  ToolResultSummary,
  ToolResultCompare,
  ToolResultLineage,
  ToolResultChunkHit,
  ToolResultChunk,
  ToolResultSearchDiagnostics,
} from '@/types';
import { apiGet, apiPatch, apiPost, apiPut, fetchWithInterceptors } from '@/utils/fetchInterceptor';
import { getApiUrl } from '@/utils/runtime';

const query = (values: object): string => {
  const params = new URLSearchParams();
  Object.entries(values as Record<string, string | number | boolean | undefined>).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  return params.toString();
};

export interface AttributionEvent {
  event_id: string;
  context_id: string;
  branch_id: string | null;
  model_segment_id: string;
  event_type: 'context_started' | 'branch_forked' | 'model_rotated';
  occurred_at: string;
  claimed_model_id: string | null;
  identity_source: 'unknown' | 'self_reported';
}
export interface AttributionSummary {
  total: number;
  known: number;
  verified: number;
  conflicted: number;
  executionErrors: number;
  models: Array<{ model_id: string | null; source: string; calls: number; execution_errors: number }>;
}
export interface LoopGuardSummary {
  advice: number; reviewed: number; helpful: number; falsePositive: number; ignored: number;
  unreviewed: number; assessed: number; reportedFalsePositiveRate: number | null;
  agentReactions?: { reported: number; warnings: number; accepted: number; declined: number;
    changedStrategy: number; intentionalRetry: number; source: 'self_reported' };
}
export const getLoopGuardSummary = (days = 30) =>
  apiGet<ApiResponse<LoopGuardSummary>>(`/loopguard/summary?days=${days}`);
export const saveTaskReview = (taskId: string, review: { outcome: string; trainingConsent: boolean; revision: number }) =>
  apiPut<ApiResponse<unknown>>(`/attribution/tasks/${encodeURIComponent(taskId)}/review`, review);
export const saveToolResultReview = (id: string, review: { quality: string; privacy: string; revision: number; rawSha256: string }) =>
  apiPut<ApiResponse<unknown>>(`/tool-results/${encodeURIComponent(id)}/review`, review);
export const submitLoopGuardFeedback = (resultId: string, verdict: 'helpful' | 'false_positive' | 'ignored') =>
  apiPost<ApiResponse<unknown>>(`/tool-results/${encodeURIComponent(resultId)}/loopguard-feedback`, { verdict });
export const getAttributionSummary = (days = 30) =>
  apiGet<ApiResponse<AttributionSummary>>(`/attribution/summary?days=${days}`);
export const getAttributionEvents = (traceId: string, cursor?: string) =>
  apiGet<ApiResponse<AttributionEvent[]> & { meta?: { hasMore: boolean; nextCursor?: string } }>(`/attribution/traces/${encodeURIComponent(traceId)}/events?${query({ limit: 100, cursor })}`);

export const checkToolResultHistoryAvailable = async (): Promise<boolean> => {
  const response = await apiGet<ApiResponse<{ available: boolean }>>('/tool-results/available');
  return Boolean(response.success && response.data?.available);
};

export const getToolResults = (
  page: number,
  limit: number,
  filter: ToolResultFilter,
): Promise<ApiResponse<ToolResultSummary[]> & { pagination?: PaginationInfo; meta?: ToolResultSearchDiagnostics }> =>
  filter.query
    ? apiGet(`/tool-results/search?${query({ q: filter.query, limit, ...filter, query: undefined })}`)
    : apiGet(`/tool-results?${query({ page, limit, ...filter })}`);

export const getToolResultStats = (filter: ToolResultFilter): Promise<ApiResponse<ToolResultStats>> =>
  apiGet(`/tool-results/stats?${query(filter)}`);

export const getToolResultTimeline = (
  sessionId: string,
  limit = 100,
): Promise<ApiResponse<ToolResultSummary[]>> =>
  apiGet(`/tool-results/timeline/${encodeURIComponent(sessionId)}?limit=${limit}`);

export const getToolResultConversationTimeline = (
  conversationId: string,
  limit = 100,
): Promise<ApiResponse<ToolResultSummary[]>> =>
  apiGet(`/tool-results/conversation-timeline/${encodeURIComponent(conversationId)}?limit=${limit}`);

export const getToolResultLineage = (resultId: string): Promise<ApiResponse<ToolResultLineage>> =>
  apiGet(`/tool-results/${encodeURIComponent(resultId)}/lineage`);

export const searchToolResultChunks = (
  resultId: string,
  searchQuery: string,
  limit = 10,
): Promise<ApiResponse<ToolResultChunkHit[]>> =>
  apiGet(`/tool-results/${encodeURIComponent(resultId)}/search?${query({ q: searchQuery, limit })}`);

export const getToolResultChunks = (resultId: string): Promise<ApiResponse<ToolResultChunk[]>> =>
  apiGet(`/tool-results/${encodeURIComponent(resultId)}/chunks`);

export const reindexToolResults = (
  limit = 25,
  onlyMissing = true,
): Promise<ApiResponse<{ requested: number; selected: number; indexed: number; skipped: number; embeddingFailures: number; remaining: number }>> =>
  apiPost('/tool-results/reindex', { limit, onlyMissing });

export const getToolResult = (resultId: string): Promise<ApiResponse<ToolResultDetail>> =>
  apiGet(`/tool-results/${encodeURIComponent(resultId)}`);

export const setToolResultPinned = (
  resultId: string,
  pinned: boolean,
): Promise<ApiResponse<ToolResultDetail>> =>
  apiPatch(`/tool-results/${encodeURIComponent(resultId)}/pin`, { pinned });

export const compareToolResults = (resultIds: string[]): Promise<ApiResponse<ToolResultCompare>> =>
  apiPost('/tool-results/compare', { resultIds });

export const getToolResultRaw = async (resultId: string): Promise<string> => {
  const response = await fetchWithInterceptors(
    getApiUrl(`/tool-results/${encodeURIComponent(resultId)}/raw`),
    { method: 'GET' },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || `HTTP ${response.status}`);
  }
  return response.text();
};

export const getToolResultRawRange = async (
  resultId: string,
  start: number,
  end: number,
): Promise<string> => {
  const response = await fetchWithInterceptors(
    getApiUrl(`/tool-results/${encodeURIComponent(resultId)}/range?start=${start}&end=${end}`),
    { method: 'GET' },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || `HTTP ${response.status}`);
  }
  return new TextDecoder().decode(await response.arrayBuffer());
};
