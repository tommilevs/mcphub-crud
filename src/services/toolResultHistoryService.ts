import { createHash, randomUUID } from 'node:crypto';
import { getCallAttribution } from './callAttribution.js';
import { logger } from '../utils/logger.js';
import type {
  ToolResultCaptureInput,
  ToolResultFilter,
  ToolResultRecord,
  ToolResultStats,
  ToolResultSearchHit,
  ToolResultChunkHit,
  ToolResultChunk,
} from '../types/toolResult.js';

export interface ToolResultPage {
  data: ToolResultRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ToolResultRepository {
  create(record: ToolResultRecord): Promise<ToolResultRecord>;
  enforceRetention(limit: number, username?: string): Promise<number>;
  findById(resultId: string): Promise<ToolResultRecord | null>;
  findPaginated(page: number, limit: number, filter?: ToolResultFilter): Promise<ToolResultPage>;
  findForReindex(limit: number, onlyMissing: boolean): Promise<ToolResultRecord[]>;
  countForReindex(onlyMissing: boolean): Promise<number>;
  search(query: string, limit: number, filter?: ToolResultFilter): Promise<ToolResultRecord[]>;
  indexContent?(resultId: string, content: string, embedding: number[] | null): Promise<void>;
  indexChunks?(
    resultId: string,
    chunks: Array<{ chunkIndex: number; chunkVersion: number; content: string; embedding: number[] | null }>,
  ): Promise<void>;
  searchChunks?(
    resultId: string,
    query: string,
    embedding: number[] | null,
    limit: number,
  ): Promise<ToolResultChunkHit[]>;
  listChunks?(resultId: string): Promise<ToolResultChunk[]>;
  hybridSearch?(query: string, embedding: number[] | null, limit: number, filter?: ToolResultFilter): Promise<ToolResultSearchHit[]>;
  setPinned(resultId: string, pinned: boolean): Promise<ToolResultRecord | null>;
  incrementUseCount(resultId: string): Promise<void>;
  getStats(filter?: ToolResultFilter): Promise<ToolResultStats>;
}

export interface ToolResultHistoryOptions {
  recentLimit?: number;
}

export class ToolResultHistoryService {
  private readonly recentLimit: number;

  constructor(
    private readonly repository: ToolResultRepository,
    options: ToolResultHistoryOptions = {},
  ) {
    this.recentLimit = options.recentLimit ?? 10_000;
  }

  async capture(input: ToolResultCaptureInput): Promise<ToolResultRecord | null> {
    const capturePayload = input.capturePayload !== false;
    const raw = capturePayload ? JSON.stringify(input.result ?? null) : null;
    const args = capturePayload ? JSON.stringify(input.arguments ?? {}) : null;
    const record: ToolResultRecord = {
      attribution: getCallAttribution(),
      resultId: randomUUID(),
      timestamp: new Date(),
      server: input.server,
      tool: input.tool,
      durationMs: input.durationMs,
      status: input.status,
      group: input.group,
      username: input.username,
      keyId: input.keyId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      parentResultId: input.parentResultId,
      objective: input.objective,
      arguments: args,
      raw,
      rawText: capturePayload ? this.extractText(input.result) : null,
      rawBytes: raw === null ? 0 : Buffer.byteLength(raw),
      rawSha256: raw === null ? null : createHash('sha256').update(raw).digest('hex'),
      payloadAvailable: capturePayload,
      payloadOmissionReason: capturePayload ? undefined : input.payloadOmissionReason,
      pinned: false,
      useCount: 0,
    };

    const saved = await this.repository.create(record);
    try {
      await this.repository.enforceRetention(this.recentLimit, input.username);
    } catch {
      // Persistence has already succeeded: maintenance must not hide its result_id.
      // The next capture retries retention; do not log RAW or database parameters.
      logger.warn('Tool result retention failed; saved result remains available:', saved.resultId);
    }
    return saved;
  }

  private extractText(result: unknown): string {
    if (!result || typeof result !== 'object') return String(result ?? '');
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return JSON.stringify(result);
    return content
      .filter((block): block is { text: string } => {
        return !!block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string';
      })
      .map((block) => block.text)
      .join('\n');
  }

  getByteRange(raw: string, start: number, end: number): Buffer {
    const bytes = Buffer.from(raw, 'utf8');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length) {
      throw new RangeError('Invalid byte range');
    }
    return bytes.subarray(start, end);
  }
}
