import { getAppDataSource } from '../db/connection.js';
import { ToolResultRepositoryDb } from '../db/repositories/ToolResultRepository.js';
import type { ToolResultStatus } from '../types/toolResult.js';
import { logger } from '../utils/logger.js';
import { ToolResultHistoryService } from './toolResultHistoryService.js';
import { getToolResultRepository } from './toolResultHistoryRegistry.js';
import { generateEmbedding } from './vectorSearchService.js';

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
          if (!repository?.indexContent) return;
          const embedding = await generateEmbedding(searchable, 'document');
          await repository.indexContent(saved.resultId, searchable, embedding);
        })().catch((error) => logger.warn('Failed to index tool result history:', error));
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
