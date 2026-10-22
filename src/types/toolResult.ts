export type ToolResultStatus = 'success' | 'error';

export interface ToolResultRecord {
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
  server?: string;
  tool?: string;
  status?: ToolResultStatus;
  username?: string;
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
