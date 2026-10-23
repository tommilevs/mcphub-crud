import { getAppDataSource } from '../db/connection.js';
import { ToolResultRepositoryDb } from '../db/repositories/ToolResultRepository.js';
import type { ToolResultStatus } from '../types/toolResult.js';
import { logger } from '../utils/logger.js';
import { ToolResultHistoryService } from './toolResultHistoryService.js';
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

export const chunkToolResultText = (
  text: string,
  maxChars = TOOL_RESULT_CHUNK_CHARS,
): string[] => {
  if (!text) return [];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < line.length; offset += maxChars) {
        chunks.push(line.slice(offset, offset + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
      const saved = await history.capture({
        ...metadata,
        result,
        capturePayload: !metadata.sensitive,
        payloadOmissionReason: metadata.sensitive
          ? 'personal authentication policy'
          : undefined,
      });
      if (!saved) return result;
      if (saved.payloadAvailable && saved.rawText) {
        const searchable = [saved.server, saved.tool, saved.objective, saved.rawText]
          .filter(Boolean)
          .join('\n')
          .slice(0, 64_000);
        void (async () => {
          const repository = getToolResultRepository();
          if (!repository) return;
          const chunks = chunkToolResultText(searchable);
          if (repository.indexChunks) {
            const indexed = [];
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
              recordToolResultIndexAttempt();
              let embedding: number[] | null = null;
              try {
                embedding = await generateEmbedding(chunks[chunkIndex], 'document');
              } catch (error) {
                recordToolResultIndexFailure();
                logger.warn('Failed to generate tool result chunk embedding:', error);
              }
              indexed.push({ chunkIndex, chunkVersion: 1, content: chunks[chunkIndex], embedding });
            }
            await repository.indexChunks(saved.resultId, indexed);
            return;
          }
          if (!repository.indexContent) return;
          recordToolResultIndexAttempt();
          const embedding = await generateEmbedding(searchable, 'document');
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
      return {
        ...result,
        _meta: {
          ...currentMeta,
          'mcphub/result_id': saved.resultId,
        },
      };
    } catch (error) {
      logger.error('Failed to persist tool result history:', error);
      return result;
    }
  }
}

let historyService: ToolResultHistoryService | undefined;

const getDatabaseHistoryService = (): ToolResultHistoryService | undefined => {
  try {
    if (!historyService) {
      historyService = new ToolResultHistoryService(
        new ToolResultRepositoryDb(getAppDataSource()),
      );
    }
    return historyService;
  } catch {
    return undefined;
  }
};

const coordinator = new ToolResultHistoryCoordinator(getDatabaseHistoryService);

export const getToolResultHistoryCoordinator = (): ToolResultHistoryCoordinator => coordinator;
