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
  ToolResultSearchDiagnostics,
} from '@/types';
import { apiGet, apiPatch, apiPost, fetchWithInterceptors } from '@/utils/fetchInterceptor';
import { getApiUrl } from '@/utils/runtime';

const query = (values: object): string => {
  const params = new URLSearchParams();
  Object.entries(values as Record<string, string | number | boolean | undefined>).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  return params.toString();
};

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
