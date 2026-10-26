import {rememberSavedResult} from './toolResultRetrieval.js';
import {originalResultWindows} from './originalResultWindows.js';
import { observeLoopGuard } from './loopGuardCoordinator.js';
import type { ToolResultStatus } from '../types/toolResult.js';
import { logger } from '../utils/logger.js';
import { ToolResultHistoryService, extractToolResultText, type ToolResultRepository } from './toolResultHistoryService.js';
import { getToolResultRepository } from './toolResultHistoryRegistry.js';
import { generateEmbedding } from './vectorSearchService.js';
import { recordToolResultIndexAttempt, recordToolResultIndexFailure } from './toolResultMetricsService.js';

export interface ToolResultHistoryCapture {
  server: string;
  tool: string;
  durationMs: number;
  status: ToolResultStatus;
  arguments?: unknown;
  group?: string;
  username?: string;
  keyId?: string;
  sessionId?: string;
  conversationId?: string;
  parentResultId?: string;
  objective?: string;
  sensitive?: boolean;
}

export const TOOL_RESULT_CHUNK_CHARS = 12_000;
export const TOOL_RESULT_CHUNK_VERSION = 2;

export interface ToolResultReindexSummary {
  nextCursor?: string;
  requested: number;
  selected: number;
  indexed: number;
  skipped: number;
  embeddingFailures: number;
  remaining: number;
}

let reindexInFlight = false;

export const chunkToolResultText = (
  text: string,
  maxChars = TOOL_RESULT_CHUNK_CHARS,
  bodyStart=0,
): string[] => {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError('Chunk size must be an integer of at least two UTF-16 code units');
  }
  return originalResultWindows(text,maxChars,bodyStart).map(window=>window.text);
};

export const reindexToolResultHistory = async (
  limit = 25,
  onlyMissing = true,
  afterResultId?: string,
): Promise<ToolResultReindexSummary> => {
  if (reindexInFlight) throw new Error('A tool result reindex pass is already running');
  const repository = getToolResultRepository();
  if (!repository?.findForReindex || (!repository.indexChunks && !repository.indexContent)) {
    throw new Error('Tool result reindex is unavailable');
  }
  reindexInFlight = true;
  const summary: ToolResultReindexSummary = {
    requested: limit,
    selected: 0,
    indexed: 0,
    skipped: 0,
    embeddingFailures: 0,
    remaining: 0,
  };
  try {
    const records = await repository.findForReindex(limit, onlyMissing, afterResultId);
    summary.selected = records.length;
    for (const record of records) {
      let text = record.rawText;
      if (record.raw && record.payloadAvailable !== false) {
        try { text = extractToolResultText(JSON.parse(record.raw)); }
        catch { /* Retain the existing derived text if historical RAW is malformed. */ }
      }
      if (!text) {
        summary.skipped += 1;
        continue;
      }
      const searchable = [record.server, record.tool, record.objective, text]
        .filter(Boolean)
        .join('\n');
      const chunks = chunkToolResultText(searchable,TOOL_RESULT_CHUNK_CHARS,searchable.length-text.length);
      if (chunks.length === 0) {
        summary.skipped += 1;
        continue;
      }
      if (repository.indexChunks) {
        const indexed = [];
        let embeddingBudget = 64_000;
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          recordToolResultIndexAttempt();
          let embedding: number[] | null = null;
          try {
            const embeddingText = chunks[chunkIndex].slice(0, embeddingBudget).replace(/[\uD800-\uDBFF]$/, '');
            embeddingBudget -= embeddingText.length;
            if (embeddingText) embedding = await generateEmbedding(embeddingText, 'document');
          } catch (error) {
            summary.embeddingFailures += 1;
            recordToolResultIndexFailure();
            logger.warn('Failed to generate tool result reindex embedding:', error);
          }
          indexed.push({ chunkIndex, chunkVersion: TOOL_RESULT_CHUNK_VERSION, content: chunks[chunkIndex], embedding });
        }
        await repository.indexChunks(record.resultId, indexed);
      } else {
        recordToolResultIndexAttempt();
        let embedding: number[] | null = null;
        try {
          embedding = await generateEmbedding(searchable.slice(0, 64_000).replace(/[\uD800-\uDBFF]$/, ''), 'document');
        } catch (error) {
          summary.embeddingFailures += 1;
          recordToolResultIndexFailure();
          logger.warn('Failed to generate tool result reindex embedding:', error);
        }
        await repository.indexContent!(record.resultId, searchable, embedding);
      }
      summary.indexed += 1;
    }
    const lastResultId = records[records.length - 1]?.resultId ?? afterResultId;
    summary.remaining = await repository.countForReindex(onlyMissing, lastResultId);
    if (summary.remaining > 0 && records.length > 0) summary.nextCursor = lastResultId;
    return summary;
  } finally {
    reindexInFlight = false;
  }
};

type ToolResultObject = Record<string, unknown>;

export class ToolResultHistoryCoordinator {
  constructor(private readonly getHistory: () => ToolResultHistoryService | undefined) {}

  async captureAndAnnotate<T extends ToolResultObject>(
    result: T,
    metadata: ToolResultHistoryCapture,
  ): Promise<T> {
    try {
      const history = this.getHistory();
      if (!history) return result;
      // Capture the repository before awaits: a configuration change may replace
      // the active data source while this result is being persisted.
      const indexingRepository = getToolResultRepository();
      const saved = await history.capture({
        ...metadata,
        result,
        capturePayload: !metadata.sensitive,
        payloadOmissionReason: metadata.sensitive
          ? 'personal authentication policy'
          : undefined,
      });
      if (!saved) return result;
      const loopGuardAdvice = await observeLoopGuard(saved);
      if (saved.payloadAvailable && saved.rawText) {
        const searchable = [saved.server, saved.tool, saved.objective, saved.rawText]
          .filter(Boolean)
          .join('\n');
        void (async () => {
          const repository = indexingRepository;
          if (!repository) return;
          const chunks = chunkToolResultText(searchable,TOOL_RESULT_CHUNK_CHARS,searchable.length-saved.rawText!.length);
          if (repository.indexChunks) {
            const indexed = [];
            let embeddingBudget = 64_000;
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
              recordToolResultIndexAttempt();
              let embedding: number[] | null = null;
              try {
                const embeddingText = chunks[chunkIndex].slice(0, embeddingBudget).replace(/[\uD800-\uDBFF]$/, '');
                embeddingBudget -= embeddingText.length;
                if (embeddingText) embedding = await generateEmbedding(embeddingText, 'document');
              } catch (error) {
                recordToolResultIndexFailure();
                logger.warn('Failed to generate tool result chunk embedding:', error);
              }
              indexed.push({ chunkIndex, chunkVersion: TOOL_RESULT_CHUNK_VERSION, content: chunks[chunkIndex], embedding });
            }
            await repository.indexChunks(saved.resultId, indexed);
            return;
          }
          if (!repository.indexContent) return;
          recordToolResultIndexAttempt();
          const embedding = await generateEmbedding(searchable.slice(0, 64_000).replace(/[\uD800-\uDBFF]$/, ''), 'document');
          await repository.indexContent(saved.resultId, searchable, embedding);
        })().catch((error) => {
          recordToolResultIndexFailure();
          logger.warn('Failed to index tool result history:', error);
        });
      }
      const currentMeta =
        result._meta && typeof result._meta === 'object'
          ? (result._meta as Record<string, unknown>)
          : {};
      const annotated = {
        ...result,
        _meta: {
          ...currentMeta,
          'mcphub/result_id': saved.resultId,
          ...(loopGuardAdvice ? { 'dev.mcphub/loopguard': loopGuardAdvice } : {}),
        },
      };
      rememberSavedResult(annotated,saved.resultId,saved.payloadAvailable,saved.raw);
      return annotated;
    } catch (error) {
      logger.error('Failed to persist tool result history:', error);
      return result;
    }
  }
}

let historyService: ToolResultHistoryService | undefined;
let historyRepository: ToolResultRepository | undefined;

const getDatabaseHistoryService = (): ToolResultHistoryService | undefined => {
  try {
    const repository = getToolResultRepository();
    if (!repository) return undefined;
    if (!historyService || historyRepository !== repository) {
      historyService = new ToolResultHistoryService(repository);
      historyRepository = repository;
    }
    return historyService;
  } catch {
    return undefined;
  }
};

const coordinator = new ToolResultHistoryCoordinator(getDatabaseHistoryService);

export const getToolResultHistoryCoordinator = (): ToolResultHistoryCoordinator => coordinator;
