import type { CallAttribution } from '../services/callAttribution.js';
export type ToolResultStatus = 'success' | 'error';

export interface ToolResultRecord {
  attribution?: CallAttribution;
  resultId: string;
  timestamp: Date;
  server: string;
  tool: string;
  durationMs: number;
  status: ToolResultStatus;
  group?: string;
  username?: string;
  keyId?: string;
  sessionId?: string;
  conversationId?: string;
  parentResultId?: string;
  objective?: string;
  arguments: string | null;
  raw: string | null;
  rawText: string | null;
  rawBytes: number;
  rawSha256: string | null;
  payloadAvailable: boolean;
  payloadOmissionReason?: string;
  pinned: boolean;
  useCount: number;
  lastReferencedAt?: Date;
}

export interface ToolResultCaptureInput {
  server: string;
  tool: string;
  durationMs: number;
  status: ToolResultStatus;
  arguments?: unknown;
  result?: unknown;
  group?: string;
  username?: string;
  keyId?: string;
  sessionId?: string;
  conversationId?: string;
  parentResultId?: string;
  objective?: string;
  capturePayload?: boolean;
  payloadOmissionReason?: string;
}

export interface ToolResultFilter {
  modelId?: string;
  taskId?: string;
  traceId?: string;
  branchId?: string;
  server?: string;
  tool?: string;
  status?: ToolResultStatus;
  username?: string;
  sessionId?: string;
  conversationId?: string;
  parentResultId?: string;
  pinned?: boolean;
  query?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface ToolResultStats {
  total: number;
  pinned: number;
  payloadAvailable: number;
  totalRawBytes: number;
  oldest?: Date;
  newest?: Date;
}

export interface ToolResultSearchHit extends ToolResultRecord {
  retrievalScore: number;
  lexicalRank?: number;
  vectorRank?: number;
}

export interface ToolResultSearchDiagnostics {
  mode: 'hybrid' | 'lexical';
  resultCount: number;
  lexicalMatches: number;
  vectorMatches: number;
  fusedMatches: number;
}

export interface ToolResultChunkHit {
  resultId: string;
  chunkIndex: number;
  chunkVersion: number;
  content: string;
  retrievalScore: number;
  lexicalRank?: number;
  vectorRank?: number;
}

export interface ToolResultChunk {
  resultId: string;
  chunkIndex: number;
  chunkVersion: number;
  content: string;
  contentBytes: number;
  hasEmbedding: boolean;
  embeddingDimensions?: number;
}
