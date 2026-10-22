import type {
  ApiResponse,
  PaginationInfo,
  ToolResultDetail,
  ToolResultFilter,
  ToolResultStats,
  ToolResultSummary,
} from '@/types';
import { apiGet, apiPatch, fetchWithInterceptors } from '@/utils/fetchInterceptor';
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
): Promise<ApiResponse<ToolResultSummary[]> & { pagination?: PaginationInfo }> =>
  apiGet(`/tool-results?${query({ page, limit, ...filter })}`);

export const getToolResultStats = (filter: ToolResultFilter): Promise<ApiResponse<ToolResultStats>> =>
  apiGet(`/tool-results/stats?${query(filter)}`);

export const getToolResult = (resultId: string): Promise<ApiResponse<ToolResultDetail>> =>
  apiGet(`/tool-results/${encodeURIComponent(resultId)}`);

export const setToolResultPinned = (
  resultId: string,
  pinned: boolean,
): Promise<ApiResponse<ToolResultDetail>> =>
  apiPatch(`/tool-results/${encodeURIComponent(resultId)}/pin`, { pinned });

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
